import assert from "node:assert/strict";
import test from "node:test";
import {
  aggregateEventFreshnessStatus,
  FreshnessAggregatePolicyError,
  type FreshnessAggregateInput,
} from "../src/layers/l4-application-integration/freshness-aggregate-policy.js";
import type { FreshnessStatus } from "../src/contracts/public-api.js";

/**
 * F-06: dedicated unit tests for the event-level freshness aggregate. The rules are written out here in
 * words, so the expectations do not reuse the implementation's branch order:
 *   1. any needs_update gives needs_update;
 *   2. current together with expired (and no needs_update) gives needs_update;
 *   3. expired alone gives expired;
 *   4. otherwise current.
 * The policy never returns anything else, and it never returns a "resolved" value.
 */

const STATUSES: readonly FreshnessStatus[] = ["current", "needs_update", "expired"];
const PRIVATE_MARKER = "private-aggregate-marker-must-not-echo";

function expectedAggregate(statuses: readonly FreshnessStatus[]): FreshnessStatus {
  if (statuses.includes("needs_update")) return "needs_update";
  if (statuses.includes("current") && statuses.includes("expired")) return "needs_update";
  if (statuses.includes("expired")) return "expired";
  return "current";
}

/** Every impact list of length 0 to 3 over the three statuses, in order: 1 + 3 + 9 + 27 = 40 lists. */
function allImpactLists(): FreshnessStatus[][] {
  const lists: FreshnessStatus[][] = [[]];
  for (let length = 1; length <= 3; length += 1) {
    const shorter = lists.filter((list) => list.length === length - 1);
    for (const prefix of shorter) {
      for (const status of STATUSES) lists.push([...prefix, status]);
    }
  }
  return lists;
}

test("the aggregate matches the written rules for every claim status and every impact list up to three entries", () => {
  const impactLists = allImpactLists();
  assert.equal(impactLists.length, 40);
  let checked = 0;
  for (const claimSetStatus of STATUSES) {
    for (const impactStatuses of impactLists) {
      const actual = aggregateEventFreshnessStatus({ claimSetStatus, impactStatuses });
      assert.equal(actual, expectedAggregate([claimSetStatus, ...impactStatuses]),
        `${claimSetStatus} with [${impactStatuses.join(", ")}]`);
      checked += 1;
    }
  }
  assert.equal(checked, 120);
});

test("the four named rules hold with one example each", () => {
  assert.equal(aggregateEventFreshnessStatus({ claimSetStatus: "needs_update", impactStatuses: ["current", "expired"] }), "needs_update",
    "a needs_update anywhere wins, even over expired");
  assert.equal(aggregateEventFreshnessStatus({ claimSetStatus: "current", impactStatuses: ["expired"] }), "needs_update",
    "current and expired together are not a single clean status, so the event needs an update");
  assert.equal(aggregateEventFreshnessStatus({ claimSetStatus: "expired", impactStatuses: ["expired"] }), "expired",
    "expired alone stays expired");
  assert.equal(aggregateEventFreshnessStatus({ claimSetStatus: "current", impactStatuses: ["current", "current"] }), "current");
});

test("with no impacts the event takes its claim-set status unchanged", () => {
  for (const claimSetStatus of STATUSES) {
    assert.equal(aggregateEventFreshnessStatus({ claimSetStatus, impactStatuses: [] }), claimSetStatus);
  }
});

test("the result is independent of the order of impact statuses", () => {
  for (const claimSetStatus of STATUSES) {
    for (const impactStatuses of allImpactLists()) {
      const forward = aggregateEventFreshnessStatus({ claimSetStatus, impactStatuses });
      const reversed = aggregateEventFreshnessStatus({ claimSetStatus, impactStatuses: [...impactStatuses].reverse() });
      assert.equal(reversed, forward, `${claimSetStatus} with [${impactStatuses.join(", ")}]`);
    }
  }
});

test("the aggregate reads its input without changing the claim status or the impact list", () => {
  const impactStatuses = Object.freeze(["current", "expired"] as FreshnessStatus[]);
  const input = Object.freeze({ claimSetStatus: "current" as FreshnessStatus, impactStatuses }) as FreshnessAggregateInput;
  const before = JSON.stringify(input);

  assert.equal(aggregateEventFreshnessStatus(input), "needs_update");
  assert.equal(JSON.stringify(input), before);
  assert.deepEqual([...impactStatuses], ["current", "expired"]);
});

test("the aggregate never produces a status outside the three freshness values", () => {
  const outputs = new Set<string>();
  for (const claimSetStatus of STATUSES) {
    for (const impactStatuses of allImpactLists()) {
      outputs.add(aggregateEventFreshnessStatus({ claimSetStatus, impactStatuses }));
    }
  }
  assert.deepEqual([...outputs].sort(), ["current", "expired", "needs_update"]);
});

test("malformed aggregate inputs fail with one stable error that never echoes the supplied value", () => {
  const proxyWithThrowingKeys = new Proxy({}, {
    ownKeys() {
      throw new Error(PRIVATE_MARKER);
    },
  });
  const sparseImpacts: unknown[] = [];
  sparseImpacts.length = 1;
  const invalidInputs: unknown[] = [
    undefined,
    "current",
    [],
    null,
    { claimSetStatus: "current" },
    { impactStatuses: [] },
    { claimSetStatus: "current", impactStatuses: [], extra: PRIVATE_MARKER },
    { claimSetStatus: "resolved", impactStatuses: [] },
    { claimSetStatus: "Current", impactStatuses: [] },
    { claimSetStatus: "constructor", impactStatuses: [] },
    { claimSetStatus: "current", impactStatuses: "current" },
    { claimSetStatus: "current", impactStatuses: ["current", "resolved"] },
    { claimSetStatus: "current", impactStatuses: ["toString"] },
    { claimSetStatus: "current", impactStatuses: [null] },
    { claimSetStatus: "current", impactStatuses: sparseImpacts },
    Object.create({ claimSetStatus: "current", impactStatuses: [] }),
    proxyWithThrowingKeys,
  ];

  for (const input of invalidInputs) {
    assert.throws(() => aggregateEventFreshnessStatus(input as FreshnessAggregateInput), (error: unknown) => {
      assert.ok(error instanceof FreshnessAggregatePolicyError, "the error type is FreshnessAggregatePolicyError");
      assert.equal(error.code, "INVALID_INPUT");
      assert.equal(error.message, "Invalid freshness aggregation input.");
      assert.equal(error.message.includes(PRIVATE_MARKER), false);
      assert.equal(JSON.stringify(error).includes(PRIVATE_MARKER), false);
      return true;
    });
  }
});
