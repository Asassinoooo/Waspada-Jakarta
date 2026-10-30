import assert from "node:assert/strict";
import test from "node:test";
import {
  EventBroadcaster,
  createSSEResponse,
  SSE_HEADERS,
} from "../src/layers/l4-application-integration/event-broadcaster.js";

async function readStreamChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<string> {
  const decoder = new TextDecoder();
  const { value, done } = await reader.read();
  if (done || !value) return "";
  return decoder.decode(value);
}

test("event broadcaster tracks client counts and formats moderation SSE events", async () => {
  const broadcaster = new EventBroadcaster({ pingIntervalMs: 0 });

  assert.deepEqual(broadcaster.getClientCount(), { moderation: 0, public: 0 });

  const controller = new AbortController();
  const stream = broadcaster.subscribeModeration(controller.signal);
  const reader = stream.getReader();

  assert.deepEqual(broadcaster.getClientCount(), { moderation: 1, public: 0 });

  // Broadcast event
  const samplePayload = {
    proposal_id: "prop-flood-123",
    title: "Banjir di Bidara Cina",
    severity: "high",
  };
  broadcaster.broadcastModeration("proposal_created", samplePayload);

  const receivedText = await readStreamChunk(reader);
  assert.equal(
    receivedText,
    `event: proposal_created\ndata: ${JSON.stringify(samplePayload)}\n\n`,
  );

  // Clean up
  controller.abort();
  await reader.cancel().catch(() => {});
  broadcaster.close();
});

test("event broadcaster formats public SSE events and supports multiple clients", async () => {
  const broadcaster = new EventBroadcaster({ pingIntervalMs: 0 });

  const c1 = new AbortController();
  const c2 = new AbortController();

  const stream1 = broadcaster.subscribePublicEvents(c1.signal);
  const stream2 = broadcaster.subscribePublicEvents(c2.signal);

  const reader1 = stream1.getReader();
  const reader2 = stream2.getReader();

  assert.deepEqual(broadcaster.getClientCount(), { moderation: 0, public: 2 });

  const publicPayload = {
    event_id: "evt-traffic-456",
    title: "Pohon Tumbang di Kuningan",
  };
  broadcaster.broadcastPublic("event_published", publicPayload);

  const [res1, res2] = await Promise.all([
    readStreamChunk(reader1),
    readStreamChunk(reader2),
  ]);

  const expectedSSE = `event: event_published\ndata: ${JSON.stringify(publicPayload)}\n\n`;
  assert.equal(res1, expectedSSE);
  assert.equal(res2, expectedSSE);

  c1.abort();
  c2.abort();
  await Promise.all([reader1.cancel().catch(() => {}), reader2.cancel().catch(() => {})]);
  broadcaster.close();
});

test("aborting signal removes client and decrements client count", async () => {
  const broadcaster = new EventBroadcaster({ pingIntervalMs: 0 });

  const controller = new AbortController();
  const stream = broadcaster.subscribeModeration(controller.signal);
  const reader = stream.getReader();

  assert.equal(broadcaster.getClientCount().moderation, 1);

  controller.abort();

  assert.equal(broadcaster.getClientCount().moderation, 0);

  await reader.cancel().catch(() => {});
  broadcaster.close();
});

test("subscribing with an already aborted signal returns an immediately closed stream", async () => {
  const broadcaster = new EventBroadcaster({ pingIntervalMs: 0 });

  const controller = new AbortController();
  controller.abort();

  const stream = broadcaster.subscribeModeration(controller.signal);
  const reader = stream.getReader();

  assert.equal(broadcaster.getClientCount().moderation, 0);

  const { done } = await reader.read();
  assert.equal(done, true);

  broadcaster.close();
});

test("sendPing transmits keep-alive comments to all connected channels", async () => {
  const broadcaster = new EventBroadcaster({ pingIntervalMs: 0 });

  const cMod = new AbortController();
  const cPub = new AbortController();

  const modReader = broadcaster.subscribeModeration(cMod.signal).getReader();
  const pubReader = broadcaster.subscribePublicEvents(cPub.signal).getReader();

  broadcaster.sendPing();

  const [modChunk, pubChunk] = await Promise.all([
    readStreamChunk(modReader),
    readStreamChunk(pubReader),
  ]);

  assert.equal(modChunk, ": ping\n\n");
  assert.equal(pubChunk, ": ping\n\n");

  cMod.abort();
  cPub.abort();
  broadcaster.close();
});

test("createSSEResponse returns correct Content-Type and Cache-Control headers", () => {
  const stream = new ReadableStream<Uint8Array>();
  const response = createSSEResponse(stream);

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Content-Type"), SSE_HEADERS["Content-Type"]);
  assert.equal(response.headers.get("Cache-Control"), SSE_HEADERS["Cache-Control"]);
  assert.equal(response.headers.get("Connection"), SSE_HEADERS["Connection"]);
});

test("close() cleans up all connections and resets client count to zero", () => {
  const broadcaster = new EventBroadcaster({ pingIntervalMs: 0 });

  broadcaster.subscribeModeration();
  broadcaster.subscribeModeration();
  broadcaster.subscribePublicEvents();

  assert.deepEqual(broadcaster.getClientCount(), { moderation: 2, public: 1 });

  broadcaster.close();

  assert.deepEqual(broadcaster.getClientCount(), { moderation: 0, public: 0 });
});
