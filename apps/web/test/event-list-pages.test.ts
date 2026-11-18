import assert from "node:assert/strict";
import test from "node:test";
import { ApiHttpError, ApiPayloadError, listAllEvents, MAX_EVENT_PAGES, PartialEventListError } from "../src/api-client.js";

const originalFetch = globalThis.fetch;

function jsonPage(eventIds: string[], nextCursor: string | null): Response {
  return new Response(JSON.stringify({
    data: eventIds.map((eventId) => ({ event_id: eventId, version: 1 })),
    page: { next_cursor: nextCursor, cursor_expires_at: nextCursor === null ? null : "2026-11-19T10:00:00.000Z" },
  }), { status: 200, headers: { "content-type": "application/json" } });
}

test("listAllEvents follows next_cursor and merges the pages in order", async (t) => {
  const requests: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    requests.push(String(input));
    return requests.length === 1 ? jsonPage(["ev-1"], "c1") : jsonPage(["ev-21"], null);
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const events = await listAllEvents();

  assert.deepEqual(events.map((event) => event.event_id), ["ev-1", "ev-21"]);
  assert.deepEqual(requests, ["/api/v1/events", "/api/v1/events?cursor=c1"]);
});

test("listAllEvents keeps one copy of an event repeated across pages, at its first position", async (t) => {
  globalThis.fetch = (async (input: RequestInfo | URL) => (
    String(input).includes("cursor=")
      ? jsonPage(["ev-2", "ev-3"], null)
      : jsonPage(["ev-1", "ev-2"], "c1")
  )) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const events = await listAllEvents();

  assert.deepEqual(events.map((event) => event.event_id), ["ev-1", "ev-2", "ev-3"]);
});

test("a failed first page is a plain failed load, not a partial list", async (t) => {
  globalThis.fetch = (async () => new Response("private", { status: 503 })) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  await assert.rejects(listAllEvents(), (error: unknown) => {
    assert.ok(error instanceof ApiHttpError);
    assert.equal(error.status, 503);
    return true;
  });
});

test("a failed later page keeps the earlier pages and rejects with them", async (t) => {
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return calls === 1 ? jsonPage(["ev-1", "ev-2"], "c1") : new Response("private", { status: 500 });
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  await assert.rejects(listAllEvents(), (error: unknown) => {
    assert.ok(error instanceof PartialEventListError);
    assert.deepEqual(error.events.map((event) => event.event_id), ["ev-1", "ev-2"]);
    assert.ok(error.reason instanceof ApiHttpError);
    assert.equal(error.message, error.reason.message);
    return true;
  });
});

test("a later page with a malformed cursor stops the list as a partial result", async (t) => {
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return calls === 1
      ? jsonPage(["ev-1"], "c1")
      : new Response(JSON.stringify({ data: [], page: { next_cursor: 42 } }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  await assert.rejects(listAllEvents(), (error: unknown) => {
    assert.ok(error instanceof PartialEventListError);
    assert.deepEqual(error.events.map((event) => event.event_id), ["ev-1"]);
    assert.ok(error.reason instanceof ApiPayloadError);
    return true;
  });
});

test("listAllEvents stops at the page limit and reports the list as incomplete", async (t) => {
  const requests: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    requests.push(String(input));
    return jsonPage(["ev-" + requests.length], "more-" + requests.length);
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  await assert.rejects(listAllEvents(), (error: unknown) => {
    assert.ok(error instanceof PartialEventListError);
    assert.equal(requests.length, MAX_EVENT_PAGES);
    assert.equal(error.events.length, MAX_EVENT_PAGES);
    assert.ok(error.reason instanceof ApiPayloadError);
    return true;
  });
});
