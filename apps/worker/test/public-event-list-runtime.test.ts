import assert from "node:assert/strict";
import test from "node:test";
import type { SqlExecutor } from "../../db/src/sql.js";
import worker from "../src/index.js";
import {
  handlePublicApiRequest,
  type WorkerEnvironment,
} from "../src/layers/l4-application-integration/api.js";
import { createPublicEventListCursorCodec } from "../src/layers/l4-application-integration/public-event-list-cursor.js";
import { PublicEventListPageServiceError } from "../src/layers/l4-application-integration/public-event-list-page-service.js";
import {
  createPublicEventListRuntime,
  type PublicEventListRuntimeConfiguration,
  type PublicEventListSqlExecutorRunner,
} from "../src/runtime/public-event-list-runtime.js";

const testConnectionString = "postgresql://test-user:test-password@hyperdrive.example.invalid/waspada?sslmode=require";

function makeSecretHex(): string {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function emptyExecutor(onQuery: (statement: string) => void): SqlExecutor {
  return {
    async query<Row extends object>(statement: string) {
      onQuery(statement);
      return { rows: [] as readonly Row[] };
    },
    async execute() {
      throw new Error("public read must not execute a statement");
    },
  };
}

async function readJson<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

test("unset and demo modes keep the synthetic event list", async () => {
  for (const environment of [{}, { DATASET_MODE: "demo" } satisfies WorkerEnvironment]) {
    const response = await worker.fetch(
      new Request("http://localhost/api/v1/events?limit=1"),
      environment,
    );
    const body = await readJson<{
      data: Array<{ event_id: string }>;
      page: { next_cursor: string | null; cursor_expires_at: string | null };
    }>(response);

    assert.equal(response.status, 200);
    assert.equal(body.data[0]?.event_id, "synthetic-demo-01");
    assert.equal(body.page.next_cursor, "1");
  }
});

test("runtime builder accepts only exact live mode", async () => {
  const secret = makeSecretHex();
  let operations = 0;
  const withSqlExecutor: PublicEventListSqlExecutorRunner = async (_connectionString, operation) => {
    operations += 1;
    return operation(emptyExecutor(() => undefined));
  };

  for (const datasetMode of [undefined, "demo", "", "Live", "live ", "staging"]) {
    const service = await createPublicEventListRuntime(
      { datasetMode, connectionString: testConnectionString, cursorHmacKeyHex: secret },
      { withSqlExecutor },
    );
    assert.equal(service, undefined, "mode=" + String(datasetMode));
  }

  assert.equal(operations, 0);
});

test("missing or malformed connection and cursor-key configuration fails closed", async () => {
  const secret = makeSecretHex();
  let operations = 0;
  const withSqlExecutor: PublicEventListSqlExecutorRunner = async (_connectionString, operation) => {
    operations += 1;
    return operation(emptyExecutor(() => undefined));
  };
  const invalidConfigurations: PublicEventListRuntimeConfiguration[] = [
    { datasetMode: "live", cursorHmacKeyHex: secret },
    { datasetMode: "live", connectionString: "not-a-postgres-url", cursorHmacKeyHex: secret },
    { datasetMode: "live", connectionString: "postgresql://host/db", cursorHmacKeyHex: secret },
    { datasetMode: "live", connectionString: testConnectionString },
    { datasetMode: "live", connectionString: testConnectionString, cursorHmacKeyHex: "z".repeat(64) },
    { datasetMode: "live", connectionString: testConnectionString, cursorHmacKeyHex: "a".repeat(62) },
    { datasetMode: "live", connectionString: testConnectionString, cursorHmacKeyHex: " " + secret },
  ];

  for (const configuration of invalidConfigurations) {
    const service = await createPublicEventListRuntime(configuration, { withSqlExecutor });
    assert.equal(service, undefined);
  }

  assert.equal(operations, 0);
});

test("a live empty current-public page uses one request-scoped SQL operation", async () => {
  const secret = makeSecretHex();
  let operations = 0;
  let queries = 0;
  let receivedConnectionString: string | undefined;
  let candidateStatement = "";
  const withSqlExecutor: PublicEventListSqlExecutorRunner = async (connectionString, operation) => {
    operations += 1;
    receivedConnectionString = connectionString;
    return operation(emptyExecutor((statement) => {
      queries += 1;
      candidateStatement = statement;
    }));
  };
  const service = await createPublicEventListRuntime(
    { datasetMode: "live", connectionString: testConnectionString, cursorHmacKeyHex: secret },
    { withSqlExecutor, now: () => Date.parse("2026-09-27T00:00:00.000Z") },
  );
  assert.ok(service);

  const page = await service.read(new URLSearchParams());
  assert.deepEqual(page, {
    data: [],
    page: { next_cursor: null, cursor_expires_at: null },
  });
  assert.equal(receivedConnectionString, testConnectionString);
  assert.equal(operations, 1);
  assert.equal(queries, 1);
  assert.match(candidateStatement, /waspada\.public_event_versions/u);
  assert.match(candidateStatement, /current\.dataset_kind = 'live'/u);
  assert.match(candidateStatement, /ORDER BY first_published_at/u);
  assert.deepEqual(Object.keys(page).sort(), ["data", "page"]);
});

test("invalid query parameters and invalid cursors are rejected before SQL setup", async () => {
  const secret = makeSecretHex();
  let operations = 0;
  const withSqlExecutor: PublicEventListSqlExecutorRunner = async (_connectionString, operation) => {
    operations += 1;
    return operation(emptyExecutor(() => undefined));
  };
  const service = await createPublicEventListRuntime(
    { datasetMode: "live", connectionString: testConnectionString, cursorHmacKeyHex: secret },
    { withSqlExecutor },
  );
  assert.ok(service);

  for (const search of [
    new URLSearchParams("limit=not-a-number"),
    new URLSearchParams("cursor=not-a-valid-token"),
    new URLSearchParams("unknown=value"),
  ]) {
    await assert.rejects(
      service.read(search),
      (error: unknown) => error instanceof PublicEventListPageServiceError
        && error.code === "INVALID_REQUEST",
    );
  }

  assert.equal(operations, 0);
});

test("valid signed cursors pass through the imported non-extractable test key", async () => {
  const secret = makeSecretHex();
  const now = Date.parse("2026-09-27T00:00:00.000Z");
  const rawKey = new Uint8Array(secret.match(/.{2}/gu)!.map((byte) => Number.parseInt(byte, 16)));
  const signingKey = await globalThis.crypto.subtle.importKey(
    "raw",
    rawKey,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
  const codec = createPublicEventListCursorCodec({ key: signingKey, now: () => now });
  const issued = await codec.issue({
    firstPublishedAt: "2026-09-26T00:00:00.000000Z",
    eventId: "event-1",
  });
  let operations = 0;
  const withSqlExecutor: PublicEventListSqlExecutorRunner = async (_connectionString, operation) => {
    operations += 1;
    return operation(emptyExecutor(() => undefined));
  };
  const service = await createPublicEventListRuntime(
    { datasetMode: "live", connectionString: testConnectionString, cursorHmacKeyHex: secret },
    { withSqlExecutor, now: () => now },
  );
  assert.ok(service);

  const page = await service.read(new URLSearchParams({ cursor: issued.token }));
  assert.deepEqual(page.data, []);
  assert.equal(page.page.next_cursor, null);
  assert.equal(operations, 1);
});

test("database failures map to a bounded unavailable response", async () => {
  const secret = makeSecretHex();
  let operations = 0;
  const withSqlExecutor: PublicEventListSqlExecutorRunner = async () => {
    operations += 1;
    throw new Error("connection failed for postgres://private-user:private-password@db.invalid");
  };
  const service = await createPublicEventListRuntime(
    { datasetMode: "live", connectionString: testConnectionString, cursorHmacKeyHex: secret },
    { withSqlExecutor },
  );
  assert.ok(service);

  const response = await handlePublicApiRequest(
    new Request("http://localhost/api/v1/events"),
    { DATASET_MODE: "live" },
    undefined,
    service,
  );
  const body = await readJson<{ code: string; message: string; request_id: string }>(response);

  assert.equal(response.status, 500);
  assert.equal(body.code, "TEMPORARILY_UNAVAILABLE");
  assert.equal(body.message, "The public read could not be completed.");
  assert.doesNotMatch(JSON.stringify(body), /private-user|private-password|db\.invalid/u);
  assert.match(body.request_id, /^[0-9a-f-]{36}$/iu);
  assert.equal(operations, 1);
});

test("all non-list routes remain unavailable in live mode without synthetic fallback", async () => {
  const paths = [
    "/api/v1/context",
    "/api/v1/events.geojson",
    "/api/v1/events/synthetic-demo-01",
    "/api/v1/events/synthetic-demo-01/history",
    "/api/v1/unknown",
  ];
  const environment: WorkerEnvironment = { DATASET_MODE: "live" };

  for (const path of paths) {
    const response = await worker.fetch(new Request("http://localhost" + path), environment);
    const body = await readJson<{ code: string; message: string }>(response);
    assert.equal(response.status, 503, path);
    assert.equal(body.code, "TEMPORARILY_UNAVAILABLE", path);
  }

  const invalidListConfigurations: WorkerEnvironment[] = [
    environment,
    {
      DATASET_MODE: "live",
      HYPERDRIVE: { connectionString: "not-a-postgres-url" },
      PUBLIC_EVENT_LIST_CURSOR_HMAC_KEY_HEX: makeSecretHex(),
    },
    {
      DATASET_MODE: "live",
      HYPERDRIVE: { connectionString: testConnectionString },
      PUBLIC_EVENT_LIST_CURSOR_HMAC_KEY_HEX: "z".repeat(64),
    },
  ];
  for (const invalidConfiguration of invalidListConfigurations) {
    const response = await worker.fetch(
      new Request("http://localhost/api/v1/events"),
      invalidConfiguration,
    );
    const body = await readJson<{ code: string; message: string; request_id: string }>(response);
    assert.equal(response.status, 503);
    assert.equal(body.code, "TEMPORARILY_UNAVAILABLE");
    assert.equal(body.message, "The public read could not be completed.");
    assert.match(body.request_id, /^[0-9a-f-]{36}$/iu);
  }
});
