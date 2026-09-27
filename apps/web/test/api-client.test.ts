import assert from "node:assert/strict";
import test from "node:test";
import type { BriefingInterests } from "@waspada/worker/public-contracts";
import { ApiHttpError, ApiPayloadError, getEventDetail, getEventHistory, getPublicUpdates, requestBriefing } from "../src/api-client.js";

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

test("briefing POST sends only the current interests in the existing JSON request contract", async (t) => {
  const requests: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
  const interests: BriefingInterests = {
    places: ["Pondok Labu"],
    services: [],
    institutions: [],
    audiences: ["mahasiswa"],
    categories: ["disasters_weather"],
  };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ input, init });
    return new Response(JSON.stringify({ items: [], generated_at: "2026-09-25T04:06:00.000Z" }), {
      status: 200,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  await requestBriefing(interests);

  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.input, "/api/v1/briefings");
  assert.equal(requests[0]?.init?.method, "POST");
  assert.equal(requests[0]?.init?.cache, "no-store");
  assert.deepEqual(requests[0]?.init?.headers, {
    accept: "application/json",
    "content-type": "application/json",
  });
  assert.deepEqual(JSON.parse(String(requests[0]?.init?.body)), { interests });
});

test("briefing client rejects malformed or partial response data as one generic payload error", async (t) => {
  globalThis.fetch = (async () => new Response(JSON.stringify({
    generated_at: "2026-09-25T04:06:00.000Z",
    items: [{ event: { event_id: "partial" }, relevance_reasons: [] }],
  }), {
    status: 200,
    headers: { "content-type": "application/json" },
  })) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  await assert.rejects(requestBriefing({ places: ["Pondok Labu"], services: [], institutions: [], audiences: [], categories: [] }), (error: unknown) => {
    assert.ok(error instanceof ApiPayloadError);
    assert.doesNotMatch(error.message, /partial|Pondok Labu/);
    return true;
  });
});

test("updates client sends only the opaque cursor and fixed page size and validates a closed page", async (t) => {
  const requests: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
  const page = {
    items: [{
      event_id: "fictional-event-1",
      version: 2,
      change_type: "corrected",
      changed_at: "2026-09-25T04:05:00.000Z",
      summary: "Synthetic reviewed correction for a test.",
    }],
    next_cursor: "opaque-cursor-value",
    cursor_expires_at: "2026-10-25T04:05:00.000Z",
    checked_at: "2026-09-25T04:06:00.000Z",
  };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ input, init });
    return new Response(JSON.stringify(page), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  assert.deepEqual(await getPublicUpdates("prior-cursor"), page);

  assert.equal(requests.length, 1);
  assert.equal(String(requests[0]?.input).split("?")[0], "/api/v1/updates");
  const query = new URLSearchParams(String(requests[0]?.input).split("?")[1]);
  assert.deepEqual([...query.keys()], ["cursor", "limit"]);
  assert.equal(query.get("cursor"), "prior-cursor");
  assert.equal(query.get("limit"), "20");
  assert.equal(requests[0]?.init?.method, undefined);
  assert.equal(requests[0]?.init?.cache, "no-store");
  assert.deepEqual(requests[0]?.init?.headers, { accept: "application/json" });
});

test("updates client bootstraps without a cursor and preserves HTTP 410", async (t) => {
  const requests: Array<RequestInfo | URL> = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    requests.push(input);
    return new Response(JSON.stringify({
      items: [],
      next_cursor: "baseline-cursor",
      cursor_expires_at: "2026-10-25T04:05:00.000Z",
      checked_at: "2026-09-25T04:06:00.000Z",
    }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  await getPublicUpdates();
  assert.equal(String(requests[0]), "/api/v1/updates?limit=20");

  globalThis.fetch = (async () => new Response("private cursor details", { status: 410 })) as typeof fetch;
  await assert.rejects(getPublicUpdates("expired-cursor"), (error: unknown) => {
    assert.ok(error instanceof ApiHttpError);
    assert.equal(error.status, 410);
    assert.doesNotMatch(error.message, /private cursor details/);
    return true;
  });
});

test("updates client rejects extra fields, malformed timestamps, oversized pages, and invalid cursor input", async (t) => {
  const validPage = {
    items: [],
    next_cursor: "cursor",
    cursor_expires_at: "2026-10-25T04:05:00.000Z",
    checked_at: "2026-09-25T04:06:00.000Z",
  };
  globalThis.fetch = (async () => new Response(JSON.stringify({ ...validPage, extra: "not in the contract" }), {
    status: 200,
    headers: { "content-type": "application/json" },
  })) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  await assert.rejects(getPublicUpdates(), ApiPayloadError);
  globalThis.fetch = (async () => new Response(JSON.stringify({ ...validPage, checked_at: "yesterday" }), {
    status: 200,
    headers: { "content-type": "application/json" },
  })) as typeof fetch;
  await assert.rejects(getPublicUpdates(), ApiPayloadError);
  globalThis.fetch = (async () => new Response(JSON.stringify({ ...validPage, items: Array.from({ length: 21 }, () => ({})) }), {
    status: 200,
    headers: { "content-type": "application/json" },
  })) as typeof fetch;
  await assert.rejects(getPublicUpdates(), ApiPayloadError);
  await assert.rejects(getPublicUpdates("x".repeat(2_049)), ApiPayloadError);
});
