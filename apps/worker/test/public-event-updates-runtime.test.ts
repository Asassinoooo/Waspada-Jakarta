import assert from "node:assert/strict";
import test from "node:test";
import type { SqlExecutor } from "../../db/src/sql.js";
import {
  createPublicEventUpdatesCursorCodec,
  PUBLIC_EVENT_UPDATES_CURSOR_TTL_MS,
} from "../src/layers/l4-application-integration/public-event-updates-cursor.js";
import {
  createPublicEventUpdatesRuntime,
  PublicEventUpdatesRuntimeError,
  readPublicEventUpdatesQuery,
  type PublicEventUpdatesRequest,
  type PublicEventUpdatesRuntimeConfiguration,
  type PublicEventUpdatesSqlExecutorRunner,
} from "../src/runtime/public-event-updates-runtime.js";

const testConnectionString = "postgresql://test-user:test-password@hyperdrive.example.invalid/waspada?sslmode=require";
const testSecret = "a1".repeat(32);
const fixedNow = Date.parse("2026-09-27T00:00:00.000Z");
const watermark = "10";

interface RunnerFixtureOptions {
  readonly watermark?: string;
  readonly candidates?: readonly Record<string, unknown>[];
  readonly failOn?: "watermark" | "candidates" | "commit" | "rollback";
  readonly failRollback?: boolean;
  readonly failAfterOperation?: boolean;
}

function makeCandidate(sequence: string, eventId: string) {
  return {
    dataset_kind: "live",
    event_id: eventId,
    event_version: 2,
    change_sequence: sequence,
    change_type: "corrected",
    summary: "Authored fictional moderator-reviewed update summary.",
    published_at: "2026-09-26T23:59:00.000Z",
  };
}

function makeRunner(options: RunnerFixtureOptions = {}) {
  const statements: string[] = [];
  const parameters: unknown[][] = [];
  let connectionCalls = 0;
  const executor: SqlExecutor = {
    async query<Row extends object>(statement: string, values: readonly unknown[] = []) {
      statements.push(statement);
      parameters.push([...values]);
      if (statement === "COMMIT" && options.failOn === "commit") throw new Error("commit marker");
      if (statement === "ROLLBACK" && (options.failOn === "rollback" || options.failRollback)) throw new Error("rollback marker");
      if (statement.includes("public_event_updates_watermark")) {
        if (options.failOn === "watermark") throw new Error("watermark marker");
        return { rows: [{ through_sequence: options.watermark ?? watermark }] as unknown as readonly Row[] };
      }
      if (statement.includes("public_event_updates_candidates")) {
        if (options.failOn === "candidates") throw new Error("candidate marker");
        return { rows: [...(options.candidates ?? [])] as unknown as readonly Row[] };
      }
      return { rows: [] as readonly Row[] };
    },
    async execute() {
      throw new Error("the public updates runtime must use read-only queries");
    },
  };
  const withSqlExecutor: PublicEventUpdatesSqlExecutorRunner = async (connectionString, operation) => {
    connectionCalls += 1;
    assert.equal(connectionString, testConnectionString);
    const result = await operation(executor);
    if (options.failAfterOperation) throw new Error("client cleanup marker");
    return result;
  };
  return {
    withSqlExecutor,
    statements,
    parameters,
    get connectionCalls() { return connectionCalls; },
  };
}

function liveConfiguration(
  additions: Partial<PublicEventUpdatesRuntimeConfiguration> = {},
): PublicEventUpdatesRuntimeConfiguration {
  return {
    datasetMode: "live",
    connectionString: testConnectionString,
    cursorHmacKeyHex: testSecret,
    ...additions,
  };
}

async function createTestCursor(sequence: string, now = fixedNow): Promise<string> {
  const key = await globalThis.crypto.subtle.importKey(
    "raw",
    decodeHex(testSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
  return (await createPublicEventUpdatesCursorCodec({ key, now: () => now }).issue(sequence)).token;
}

async function createWrongScopeCursor(now = fixedNow): Promise<string> {
  const key = await globalThis.crypto.subtle.importKey(
    "raw",
    decodeHex(testSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
  const payload = JSON.stringify({
    dataset: "demo",
    sequence: "2",
    expires_at: new Date(now + PUBLIC_EVENT_UPDATES_CURSOR_TTL_MS).toISOString(),
  });
  const encodedPayload = Buffer.from(payload, "utf8").toString("base64url");
  const prefix = "v1." + encodedPayload;
  const signature = await globalThis.crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode("waspada.public-event-updates.cursor.signature.v1\u0000" + prefix + "."),
  );
  return prefix + "." + Buffer.from(signature).toString("base64url");
}

function decodeHex(value: string): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(new ArrayBuffer(value.length / 2));
  for (let offset = 0; offset < value.length; offset += 2) {
    bytes[offset / 2] = Number.parseInt(value.slice(offset, offset + 2), 16);
  }
  return bytes;
}

async function createRuntime(
  runner: ReturnType<typeof makeRunner>,
  now: () => number = () => fixedNow,
) {
  const runtime = await createPublicEventUpdatesRuntime(liveConfiguration(), {
    withSqlExecutor: runner.withSqlExecutor,
    now,
  });
  assert.ok(runtime);
  return runtime;
}

test("query parser accepts only canonical documented parameters", () => {
  assert.deepEqual(readPublicEventUpdatesQuery(new URLSearchParams()), {
    cursor: undefined,
    limit: 20,
  });
  assert.deepEqual(readPublicEventUpdatesQuery(new URLSearchParams("cursor=opaque&limit=100")), {
    cursor: "opaque",
    limit: 100,
  });

  for (const query of [
    new URLSearchParams("unknown=x"),
    new URLSearchParams("limit=1&limit=2"),
    new URLSearchParams("cursor=a&cursor=b"),
    new URLSearchParams("cursor="),
    new URLSearchParams("cursor=" + "x".repeat(2_049)),
    new URLSearchParams("limit=0"),
    new URLSearchParams("limit=01"),
    new URLSearchParams("limit=+1"),
    new URLSearchParams("limit=101"),
    new URLSearchParams("limit=1.0"),
  ]) {
    assert.throws(
      () => readPublicEventUpdatesQuery(query),
      (error: unknown) => error instanceof PublicEventUpdatesRuntimeError
        && error.code === "INVALID_REQUEST",
    );
  }
});

test("configuration fails closed outside live mode or without valid existing bindings", async () => {
  const runner = makeRunner();
  for (const datasetMode of [undefined, "demo", "Live", "live ", "staging"]) {
    const runtime = await createPublicEventUpdatesRuntime(
      liveConfiguration({ datasetMode }),
      { withSqlExecutor: runner.withSqlExecutor },
    );
    assert.equal(runtime, undefined);
  }
  for (const configuration of [
    liveConfiguration({ connectionString: undefined }),
    liveConfiguration({ connectionString: "not-a-postgres-url" }),
    liveConfiguration({ cursorHmacKeyHex: undefined }),
    liveConfiguration({ cursorHmacKeyHex: "z".repeat(64) }),
    liveConfiguration({ cursorHmacKeyHex: "ab".repeat(31) }),
  ]) {
    assert.equal(await createPublicEventUpdatesRuntime(configuration, {
      withSqlExecutor: runner.withSqlExecutor,
    }), undefined);
  }
  assert.equal(runner.connectionCalls, 0);
});

test("bootstrap reads only the transactional watermark in one read-only snapshot", async () => {
  const runner = makeRunner();
  const runtime = await createRuntime(runner);
  const page = await runtime.read(new URLSearchParams());
  const next = await (async () => {
    const key = await globalThis.crypto.subtle.importKey(
      "raw", decodeHex(testSecret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"],
    );
    return createPublicEventUpdatesCursorCodec({ key, now: () => fixedNow }).decode(page.next_cursor);
  })();

  assert.equal(runner.connectionCalls, 1);
  assert.deepEqual(runner.statements.map((statement) => statement.trim()), [
    "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY",
    "SELECT through_sequence::text AS through_sequence\nFROM waspada.public_event_updates_watermark",
    "COMMIT",
  ]);
  assert.equal(runner.statements.some((statement) => statement.includes("public_event_updates_candidates")), false);
  assert.deepEqual(page.items, []);
  assert.deepEqual(Object.keys(page).sort(), ["checked_at", "cursor_expires_at", "items", "next_cursor"]);
  assert.deepEqual(next.sequence, watermark);
  assert.equal(page.checked_at, "2026-09-27T00:00:00.000Z");
});

test("a valid cursor reads one bounded ordered candidate page in the same transaction", async () => {
  const runner = makeRunner({
    candidates: [makeCandidate("3", "event-fictional-current-03"), makeCandidate("4", "event-fictional-current-04")],
  });
  const runtime = await createRuntime(runner);
  const cursor = await createTestCursor("2");
  const page = await runtime.read(new URLSearchParams({ cursor, limit: "1" }));

  assert.equal(runner.connectionCalls, 1);
  assert.equal(runner.statements[0]?.trim(), "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  assert.equal(runner.statements.at(-1)?.trim(), "COMMIT");
  assert.equal(runner.statements.filter((statement) => statement.includes("public_event_updates_watermark")).length, 1);
  assert.equal(runner.statements.filter((statement) => statement.includes("public_event_updates_candidates")).length, 1);
  const candidateStatementIndex = runner.statements.findIndex((statement) => statement.includes("public_event_updates_candidates"));
  const candidateStatement = runner.statements[candidateStatementIndex];
  assert.ok((candidateStatement ?? "").includes("change_sequence > $1::bigint AND candidates.change_sequence <= $2::bigint"));
  assert.match(candidateStatement ?? "", /ORDER BY candidates\.change_sequence ASC/u);
  assert.deepEqual(runner.parameters[candidateStatementIndex], ["2", watermark, 2]);
  assert.deepEqual(page.items, [{
    event_id: "event-fictional-current-03",
    version: 2,
    change_type: "corrected",
    changed_at: "2026-09-26T23:59:00.000Z",
    summary: "Authored fictional moderator-reviewed update summary.",
  }]);
  assert.deepEqual(Object.keys(page.items[0] ?? {}).sort(), ["change_type", "changed_at", "event_id", "summary", "version"]);
  const key = await globalThis.crypto.subtle.importKey(
    "raw", decodeHex(testSecret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"],
  );
  const continuation = await createPublicEventUpdatesCursorCodec({ key, now: () => fixedNow }).decode(page.next_cursor);
  assert.equal(continuation.sequence, "3");
  assert.equal(page.cursor_expires_at, continuation.expiresAt);
});

test("malformed, tampered, wrong-scope, and expired cursors never open SQL", async () => {
  const runner = makeRunner();
  const runtime = await createRuntime(runner);
  const valid = await createTestCursor("2");
  const expired = await createTestCursor("2", fixedNow - PUBLIC_EVENT_UPDATES_CURSOR_TTL_MS);
  const wrongScope = await createWrongScopeCursor();
  const malformedCursors = ["malformed-token", valid.slice(0, -1) + (valid.endsWith("A") ? "B" : "A"), wrongScope];
  for (const cursor of malformedCursors) {
    await assert.rejects(
      runtime.read(new URLSearchParams({ cursor })),
      (error: unknown) => error instanceof PublicEventUpdatesRuntimeError
        && error.code === "INVALID_REQUEST",
    );
  }
  await assert.rejects(
    runtime.read(new URLSearchParams({ cursor: expired })),
    (error: unknown) => error instanceof PublicEventUpdatesRuntimeError
      && error.code === "CURSOR_RESTART_REQUIRED",
  );
  for (const badQuery of [
    new URLSearchParams("limit=00"),
    new URLSearchParams("limit=101"),
    new URLSearchParams("cursor=x&cursor=y"),
    new URLSearchParams("unexpected=x"),
  ]) {
    await assert.rejects(
      runtime.read(badQuery),
      (error: unknown) => error instanceof PublicEventUpdatesRuntimeError
        && error.code === "INVALID_REQUEST",
    );
  }
  assert.equal(runner.connectionCalls, 0);
});

test("one request clock keeps cursor preflight and service expiry checks consistent", async () => {
  const runner = makeRunner();
  const cursor = await createTestCursor("2");
  let clockCalls = 0;
  const expiryBoundary = fixedNow + PUBLIC_EVENT_UPDATES_CURSOR_TTL_MS;
  const runtime = await createRuntime(runner, () => {
    clockCalls += 1;
    return clockCalls === 1 ? expiryBoundary - 1 : expiryBoundary;
  });
  const page = await runtime.read(new URLSearchParams({ cursor }));

  assert.deepEqual(page.items, []);
  assert.equal(clockCalls, 1);
  assert.equal(runner.connectionCalls, 1);
  assert.equal(runner.statements.at(-1)?.trim(), "COMMIT");
});

test("ahead cursors roll back and never read candidates", async () => {
  const runner = makeRunner({ watermark: "10" });
  const runtime = await createRuntime(runner);
  const cursor = await createTestCursor("11");
  await assert.rejects(
    runtime.read({ cursor, limit: 20 } satisfies PublicEventUpdatesRequest),
    (error: unknown) => error instanceof PublicEventUpdatesRuntimeError
      && error.code === "CURSOR_RESTART_REQUIRED",
  );
  assert.equal(runner.connectionCalls, 1);
  assert.equal(runner.statements.some((statement) => statement.includes("public_event_updates_candidates")), false);
  assert.equal(runner.statements.at(-1)?.trim(), "ROLLBACK");
});

test("reader, projection, commit, and rollback failures stay generic", async () => {
  const cursor = await createTestCursor("2");
  for (const options of [
    { failOn: "watermark" as const },
    { failOn: "candidates" as const },
    { failOn: "commit" as const },
    {
      candidates: [{ ...makeCandidate("3", "event-fictional-invalid"), reviewer_id: "private-reviewer-marker" }],
    },
  ]) {
    const runner = makeRunner(options);
    const runtime = await createRuntime(runner);
    await assert.rejects(
      runtime.read(new URLSearchParams({ cursor })),
      (error: unknown) => error instanceof PublicEventUpdatesRuntimeError
        && error.code === "READ_FAILED",
    );
    assert.equal(runner.statements.at(-1)?.trim(), "ROLLBACK");
    assert.equal(runner.statements.some((statement) => statement.trim() === "COMMIT"), options.failOn !== "commit" ? false : true);
  }

  const rollbackRunner = makeRunner({ failOn: "watermark", failRollback: true });
  const rollbackRuntime = await createRuntime(rollbackRunner);
  await assert.rejects(
    rollbackRuntime.read(new URLSearchParams()),
    (error: unknown) => error instanceof PublicEventUpdatesRuntimeError
      && error.code === "READ_FAILED",
  );

  const cleanupRunner = makeRunner({ watermark: "10", failAfterOperation: true });
  const cleanupRuntime = await createRuntime(cleanupRunner);
  const aheadCursor = await createTestCursor("11");
  await assert.rejects(
    cleanupRuntime.read(new URLSearchParams({ cursor: aheadCursor })),
    (error: unknown) => error instanceof PublicEventUpdatesRuntimeError
      && error.code === "READ_FAILED",
  );
  assert.equal(cleanupRunner.statements.at(-1)?.trim(), "ROLLBACK");
});
