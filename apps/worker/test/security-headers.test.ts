/**
 * SEC-HEADERS-01 (NFR-07): Worker response headers and the plain-http redirect for /api/.
 * The helpers are tested directly; the default export is tested once to prove the wiring.
 */
import assert from "node:assert/strict";
import test from "node:test";
import worker from "../src/index.js";
import { eventBroadcaster } from "../src/layers/l4-application-integration/event-broadcaster.js";
import {
  API_SECURITY_HEADERS,
  httpsApiRedirect,
  withSecurityHeaders,
} from "../src/security/security-headers.js";

const EXPECTED_HEADERS: Readonly<Record<string, string>> = {
  "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
  "strict-transport-security": "max-age=31536000; includeSubDomains",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "strict-origin-when-cross-origin",
};

const demoEnvironment = { DATASET_MODE: "demo" as const };

function assertSecurityHeaders(headers: Headers): void {
  for (const [name, value] of Object.entries(EXPECTED_HEADERS)) {
    assert.equal(headers.get(name), value, `${name} is set`);
  }
}

test("the header table matches the values the tests expect", () => {
  assert.deepEqual(
    Object.fromEntries(Object.entries(API_SECURITY_HEADERS).map(([name, value]) => [name.toLowerCase(), value])),
    EXPECTED_HEADERS,
  );
});

test("a JSON response gets every security header and keeps its status, type, cache policy and body", async () => {
  const original = new Response(JSON.stringify({ ok: true }), {
    status: 201,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

  const wrapped = withSecurityHeaders(original);

  assert.equal(wrapped.status, 201);
  assertSecurityHeaders(wrapped.headers);
  assert.equal(wrapped.headers.get("content-type"), "application/json; charset=utf-8");
  assert.equal(wrapped.headers.get("cache-control"), "no-store");
  assert.deepEqual(await wrapped.json(), { ok: true });
});

test("headers a route already sets are kept, not overridden", () => {
  const wrapped = withSecurityHeaders(
    new Response("{}", {
      headers: {
        "content-security-policy": "default-src 'self'",
        "x-frame-options": "SAMEORIGIN",
      },
    }),
  );

  assert.equal(wrapped.headers.get("content-security-policy"), "default-src 'self'");
  assert.equal(wrapped.headers.get("x-frame-options"), "SAMEORIGIN");
  assert.equal(wrapped.headers.get("x-content-type-options"), "nosniff");
});

test("every Set-Cookie header survives the rebuild", () => {
  const original = new Response(null, { status: 204 });
  original.headers.append("set-cookie", "a=1; Path=/; HttpOnly");
  original.headers.append("set-cookie", "b=2; Path=/; HttpOnly");

  const wrapped = withSecurityHeaders(original);

  assert.deepEqual(wrapped.headers.getSetCookie(), ["a=1; Path=/; HttpOnly", "b=2; Path=/; HttpOnly"]);
  assert.equal(wrapped.status, 204);
  assert.equal(wrapped.body, null);
});

test("an SSE stream is passed through unread, so its chunks arrive intact and in order", async () => {
  const encoder = new TextEncoder();
  const chunks = ["event: a\ndata: 1\n\n", "event: b\ndata: 2\n\n"];
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  const original = new Response(stream, {
    headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform" },
  });

  const wrapped = withSecurityHeaders(original);

  assert.equal(wrapped.headers.get("content-type"), "text/event-stream; charset=utf-8");
  assert.equal(wrapped.headers.get("cache-control"), "no-cache, no-transform");
  assertSecurityHeaders(wrapped.headers);
  assert.equal(await wrapped.text(), chunks.join(""));
});

test("a 101 response is returned as it is, because it cannot be rebuilt", () => {
  const upgrade = { status: 101, headers: new Headers() } as unknown as Response;
  assert.equal(withSecurityHeaders(upgrade), upgrade);
});

test("plain-http /api/ requests are redirected with 308 to the same https URL", () => {
  const redirect = httpsApiRedirect(new Request("http://waspada.example/api/v1/events?limit=5&cursor=abc"));

  assert.ok(redirect);
  assert.equal(redirect.status, 308);
  assert.equal(redirect.headers.get("location"), "https://waspada.example/api/v1/events?limit=5&cursor=abc");
});

test("the default :80 port disappears on the https redirect and any other port is kept", () => {
  assert.equal(
    httpsApiRedirect(new Request("http://waspada.example:80/api/v1/context"))?.headers.get("location"),
    "https://waspada.example/api/v1/context",
  );
  assert.equal(
    httpsApiRedirect(new Request("http://waspada.example:8080/api/v1/context"))?.headers.get("location"),
    "https://waspada.example:8080/api/v1/context",
  );
});

test("https requests, non-API paths and loopback development hosts are not redirected", () => {
  assert.equal(httpsApiRedirect(new Request("https://waspada.example/api/v1/context")), null);
  assert.equal(httpsApiRedirect(new Request("http://waspada.example/")), null);
  assert.equal(httpsApiRedirect(new Request("http://waspada.example/apiary")), null);
  assert.equal(httpsApiRedirect(new Request("http://localhost:8787/api/v1/context")), null);
  assert.equal(httpsApiRedirect(new Request("http://127.0.0.1:8787/api/v1/context")), null);
  assert.equal(httpsApiRedirect(new Request("http://[::1]:8787/api/v1/context")), null);
});

test("the default export redirects plain-http API requests and adds headers to https API responses", async () => {
  const redirect = await worker.fetch(new Request("http://waspada.example/api/v1/context"), demoEnvironment);
  assert.equal(redirect.status, 308);
  assert.equal(redirect.headers.get("location"), "https://waspada.example/api/v1/context");

  const json = await worker.fetch(new Request("https://waspada.example/api/v1/context"), demoEnvironment);
  assert.equal(json.status, 200);
  assert.match(json.headers.get("content-type") ?? "", /application\/json/u);
  assertSecurityHeaders(json.headers);
  assert.equal(typeof (await json.json()), "object");
});

test("the public SSE stream through the default export keeps streaming with its headers", async () => {
  const controller = new AbortController();
  const response = await worker.fetch(
    new Request("https://waspada.example/api/v1/events/stream", { signal: controller.signal }),
    demoEnvironment,
  );
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/u);
  assertSecurityHeaders(response.headers);

  const reader = response.body!.getReader();
  eventBroadcaster.broadcastPublic("event_published", { event_id: "sec-headers-probe", version: 1 });
  const first = await reader.read();
  const text = new TextDecoder().decode(first.value);
  assert.match(text, /event: event_published/u);
  assert.match(text, /sec-headers-probe/u);

  controller.abort();
  await reader.cancel().catch(() => {});
});
