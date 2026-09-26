import assert from "node:assert/strict";
import test from "node:test";
import { ApiHttpError, getEventDetail, getEventHistory } from "../src/api-client.js";

const originalFetch = globalThis.fetch;

test("detail and history requests use encoded IDs and existing read-only API paths", async (t) => {
  const requests: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ input, init });
    return new Response(JSON.stringify({ data: [], page: { next_cursor: null, cursor_expires_at: null } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  await getEventDetail("fictional /?# &");
  await getEventHistory("fictional /?# &");

  assert.deepEqual(requests.map(({ input }) => input), [
    "/api/v1/events/fictional%20%2F%3F%23%20%26",
    "/api/v1/events/fictional%20%2F%3F%23%20%26/history",
  ]);
  assert.ok(requests.every(({ init }) => init?.method === undefined));
  assert.ok(requests.every(({ init }) => (init?.headers as Record<string, string>).accept === "application/json"));
});

test("public API failures keep the HTTP status available without exposing response bodies", async (t) => {
  globalThis.fetch = (async () => new Response("private detail", { status: 404 })) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  await assert.rejects(getEventDetail("missing"), (error: unknown) => {
    assert.ok(error instanceof ApiHttpError);
    assert.equal(error.status, 404);
    assert.doesNotMatch(error.message, /private detail/);
    return true;
  });
});
