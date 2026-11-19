import assert from "node:assert/strict";
import test from "node:test";
import type {
  FreshnessDueTarget,
  FreshnessDueTargetPage,
  FreshnessDueTargetReader,
} from "../../db/src/freshness-due-target-reader.js";
import { createFreshnessDueEvaluator } from "../src/layers/l4-application-integration/freshness-due-evaluator.js";
import {
  createFreshnessTransitionRecorder,
  type FreshnessRecorderTransitionRecord,
  type FreshnessTransitionAppendCommand,
  type FreshnessTransitionRecorderRepository,
} from "../src/layers/l4-application-integration/freshness-transition-recorder.js";
import type { FreshnessStatus } from "../src/contracts/public-api.js";

/**
 * ST-F-14 (FR-13): fixture events for one bounded due-evaluation page, run through the real due evaluator
 * and the real transition recorder. A missing update feed contributes no evidence: the evaluator always
 * passes newApplicableEvidenceEvaluated=false and no evidence references. The only ways out of "current"
 * are the review date passing (needs_update) and the issuer validity ending (expired). Nothing reads as
 * "resolved", and no status is ever invented from the absence of a feed.
 */

const ALLOWED_STATUSES: readonly FreshnessStatus[] = ["current", "needs_update", "expired"];

function target(overrides: Partial<FreshnessDueTarget> & Pick<FreshnessDueTarget, "eventId">): FreshnessDueTarget {
  return {
    datasetKind: "synthetic",
    eventVersion: 1,
    target: { kind: "event_claim_set" },
    status: "current",
    transitionSequence: 0,
    validUntil: null,
    reviewDueAt: null,
    ...overrides,
  };
}

function pageReader(targets: readonly FreshnessDueTarget[], calls: unknown[] = []): FreshnessDueTargetReader {
  return {
    async read(request) {
      calls.push(request);
      const page: FreshnessDueTargetPage = { targets: [...targets], nextCursor: null };
      return page;
    },
  };
}

/** Stands in for the append port: it records each command and answers with the written record. */
function recordingRepository(commands: FreshnessTransitionAppendCommand[]): FreshnessTransitionRecorderRepository {
  return {
    async append(command) {
      commands.push(command);
      const record: FreshnessRecorderTransitionRecord = {
        transitionId: `transition-${commands.length}`,
        datasetKind: command.datasetKind,
        eventId: command.eventId,
        eventVersion: command.eventVersion,
        target: command.target,
        transitionSequence: command.expectedSequence,
        previousStatus: command.previousStatus,
        resultingStatus: command.resultingStatus,
        reason: command.reason,
        evaluatedAt: command.evaluatedAt,
        traceId: command.traceId,
        idempotencyKey: command.idempotencyKey,
        requestFingerprint: "f".repeat(64),
        evidenceReferenceIds: [...command.evidenceReferenceIds],
      };
      return { outcome: "written", record };
    },
  };
}

function evaluatorFor(reader: FreshnessDueTargetReader, commands: FreshnessTransitionAppendCommand[]) {
  return createFreshnessDueEvaluator({
    reader,
    recorder: createFreshnessTransitionRecorder(recordingRepository(commands)),
  });
}

function request(now: string, evaluationRunId: string) {
  return { datasetKind: "synthetic" as const, now, limit: 10, cursor: null, traceId: "trace-missing-feed", evaluationRunId };
}

test("one bounded due page: passed review date needs update, ended validity expires, a missing feed stays current", async () => {
  const commands: FreshnessTransitionAppendCommand[] = [];
  const readerCalls: unknown[] = [];
  const reader = pageReader([
    target({ eventId: "event-review-passed", reviewDueAt: "2026-09-30T10:00:00Z" }),
    target({ eventId: "event-validity-ended", validUntil: "2026-09-30T23:59:59Z", reviewDueAt: "2026-10-05T00:00:00Z" }),
    target({ eventId: "event-missing-feed", validUntil: null, reviewDueAt: "2026-10-05T00:00:00Z" }),
  ], readerCalls);

  const result = await evaluatorFor(reader, commands).evaluate(request("2026-10-01T10:00:00Z", "run-page-1"));

  assert.deepEqual(result, {
    outcome: "completed",
    counts: { written: 2, replayed: 0, noChange: 1, conflicts: 0, failures: 0 },
    nextCursor: null,
  });
  assert.equal(readerCalls.length, 1, "one bounded page is read");

  const byEvent = new Map(commands.map((command) => [command.eventId, command]));
  assert.equal(byEvent.size, 2, "the missing-feed event has no transition to record");
  assert.equal(byEvent.has("event-missing-feed"), false);

  const reviewPassed = byEvent.get("event-review-passed");
  assert.equal(reviewPassed?.resultingStatus, "needs_update");
  assert.equal(reviewPassed?.reason, "review_deadline_missed");

  const validityEnded = byEvent.get("event-validity-ended");
  assert.equal(validityEnded?.resultingStatus, "expired");
  assert.equal(validityEnded?.reason, "issuer_validity_ended");

  for (const command of commands) {
    assert.equal(command.evidenceReferenceIds.length, 0, "no evidence is claimed for any evaluated target");
  }
});

test("a missing feed never becomes expired or resolved however long it stays silent", async () => {
  const commands: FreshnessTransitionAppendCommand[] = [];
  const silentEvent = target({ eventId: "event-silent-feed", validUntil: null, reviewDueAt: "2026-10-05T00:00:00Z" });

  // Before the review date: nothing is recorded and the event stays current.
  const beforeDue = await evaluatorFor(pageReader([silentEvent]), commands)
    .evaluate(request("2026-10-02T00:00:00Z", "run-silent-1"));
  assert.equal(beforeDue.outcome, "completed");
  assert.equal(commands.length, 0);

  // After the review date, with still no feed: current becomes needs_update, not expired.
  const afterDue = await evaluatorFor(pageReader([silentEvent]), commands)
    .evaluate(request("2026-10-06T00:00:00Z", "run-silent-2"));
  assert.equal(afterDue.outcome, "completed");
  assert.equal(commands.length, 1);
  assert.equal(commands[0]?.resultingStatus, "needs_update");
  assert.equal(commands[0]?.reason, "review_deadline_missed");

  // A later run reads the stored needs_update state. With no validity window and no new evidence it stays put.
  const stored = target({
    eventId: "event-silent-feed",
    status: "needs_update",
    transitionSequence: 1,
    validUntil: null,
    reviewDueAt: "2026-10-05T00:00:00Z",
  });
  const laterRun = await evaluatorFor(pageReader([stored]), commands)
    .evaluate(request("2027-06-01T00:00:00Z", "run-silent-3"));
  assert.deepEqual(laterRun, {
    outcome: "completed",
    counts: { written: 0, replayed: 0, noChange: 1, conflicts: 0, failures: 0 },
    nextCursor: null,
  });
  assert.equal(commands.length, 1, "the sticky needs_update state adds no transition");

  const everyResultingStatus = commands.map((command) => command.resultingStatus);
  assert.deepEqual(everyResultingStatus, ["needs_update"]);
});

test("without an issuer validity window no evaluated status is expired, at any time", async () => {
  const commands: FreshnessTransitionAppendCommand[] = [];
  const reader = pageReader([
    target({ eventId: "event-open-ended-a", validUntil: null, reviewDueAt: "2026-09-30T10:00:00Z" }),
    target({ eventId: "event-open-ended-b", validUntil: null, reviewDueAt: "2026-09-30T10:00:00Z", status: "needs_update", transitionSequence: 1 }),
  ]);
  const result = await evaluatorFor(reader, commands).evaluate(request("2999-12-31T23:59:59Z", "run-open-ended"));
  assert.equal(result.outcome, "completed");
  assert.equal(commands.length, 1, "only the current event changes; the sticky needs_update event does not");
  assert.equal(commands[0]?.resultingStatus, "needs_update");
  assert.equal(commands.some((command) => command.resultingStatus === "expired"), false);
});

test("the status vocabulary the policy can produce has no resolved value", async () => {
  const commands: FreshnessTransitionAppendCommand[] = [];
  const reader = pageReader([
    target({ eventId: "event-vocab-due", reviewDueAt: "2026-09-30T10:00:00Z" }),
    target({ eventId: "event-vocab-ended", validUntil: "2026-09-30T10:00:00Z", reviewDueAt: null }),
    target({ eventId: "event-vocab-silent", validUntil: null, reviewDueAt: null }),
  ]);
  const result = await evaluatorFor(reader, commands).evaluate(request("2026-10-01T10:00:00Z", "run-vocab"));
  assert.equal(result.outcome, "completed");

  for (const command of commands) {
    assert.ok(ALLOWED_STATUSES.includes(command.resultingStatus), `resulting status ${command.resultingStatus}`);
    assert.ok(ALLOWED_STATUSES.includes(command.previousStatus), `previous status ${command.previousStatus}`);
  }
  assert.equal(JSON.stringify([result, commands]).includes("resolved"), false, "no output mentions a resolved state");
});
