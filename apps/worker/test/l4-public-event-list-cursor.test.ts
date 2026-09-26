import assert from "node:assert/strict";
import test from "node:test";
import type { PublicEventListCursor, PublicEventListFilters } from "../src/layers/l4-application-integration/public-event-list-projection-service.js";
import {
  createPublicEventListCursorCodec,
  PUBLIC_EVENT_LIST_CURSOR_TOKEN_MAX_LENGTH,
  PUBLIC_EVENT_LIST_CURSOR_TTL_MS,
  PublicEventListCursorCodecError,
  type PublicEventListCursorCodecErrorCode,
} from "../src/layers/l4-application-integration/public-event-list-cursor.js";

const nowAtIssue = Date.parse("2026-09-27T04:00:00.000Z");
const authoredCursor: PublicEventListCursor = {
  firstPublishedAt: "2026-09-26T03:12:13.123456Z",
  eventId: "synthetic-cursor-event-01",
};
const signatureDomain = "waspada.public-event-list.cursor.signature.v1\u0000";

async function generateTestKey(): Promise<CryptoKey> {
  return await globalThis.crypto.subtle.generateKey(
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

function makeCodec(key: CryptoKey, getNow: () => number) {
  return createPublicEventListCursorCodec({ key, now: getNow });
}

async function assertCodecError(
  promise: Promise<unknown>,
  code: PublicEventListCursorCodecErrorCode,
  sensitiveValues: readonly string[] = [],
): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof PublicEventListCursorCodecError);
    assert.equal(error.code, code);
    assert.equal(error.message.length < 100, true);
    for (const value of sensitiveValues) assert.equal(error.message.includes(value), false);
    return true;
  });
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/gu, "");
}

function decodeBase64Url(value: string): Uint8Array {
  const standard = value.replace(/-/gu, "+").replace(/_/gu, "/");
  const padded = standard.padEnd(Math.ceil(standard.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

async function signAuthoredPayload(key: CryptoKey, payload: unknown): Promise<string> {
  const encodedPayload = encodeBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
  const prefix = `v1.${encodedPayload}`;
  const signature = await globalThis.crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${signatureDomain}${prefix}.`),
  );
  return `${prefix}.${encodeBase64Url(new Uint8Array(signature))}`;
}

async function getPayload(token: string): Promise<Record<string, unknown>> {
  const encoded = token.split(".")[1]!;
  return JSON.parse(new TextDecoder().decode(decodeBase64Url(encoded))) as Record<string, unknown>;
}

test("issues and decodes the exact keyset with a 15-minute expiry", async () => {
  const key = await generateTestKey();
  let now = nowAtIssue;
  const codec = makeCodec(key, () => now);

  const issued = await codec.issue(authoredCursor);
  const decoded = await codec.decode(issued.token);

  assert.deepEqual(decoded.cursor, authoredCursor);
  assert.equal(issued.expiresAt, new Date(nowAtIssue + PUBLIC_EVENT_LIST_CURSOR_TTL_MS).toISOString());
  assert.equal(decoded.expiresAt, issued.expiresAt);
  assert.match(issued.token, /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u);
  assert.equal(issued.token.length <= PUBLIC_EVENT_LIST_CURSOR_TOKEN_MAX_LENGTH, true);
  now = nowAtIssue + 1;
  assert.deepEqual((await codec.decode(issued.token)).cursor, authoredCursor);
});

test("uses an opaque keyed filter binding and normalizes blank text filters", async () => {
  const key = await generateTestKey();
  const codec = makeCodec(key, () => nowAtIssue);
  const query = "flood-query-secret-941";
  const place = "ward-place-secret-628";
  const issued = await codec.issue(authoredCursor, {
    category: "disasters_weather",
    from: "2026-09-20T00:00:00Z",
    q: `  ${query}  `,
    place_id: ` ${place} `,
  });
  const payload = await getPayload(issued.token);
  const serializedPayload = JSON.stringify(payload);

  assert.deepEqual(Object.keys(payload).sort(), ["eventId", "expiresAt", "filterBinding", "firstPublishedAt"]);
  for (const rawValue of [query, place, "disasters_weather", "2026-09-20T00:00:00Z"]) {
    assert.equal(serializedPayload.includes(rawValue), false);
  }
  assert.equal(typeof payload.filterBinding, "string");
  assert.deepEqual(
    (await codec.decode(issued.token, {
      category: "disasters_weather",
      from: "2026-09-20T00:00:00Z",
      q: query.toLocaleLowerCase("id"),
      place_id: place,
    })).cursor,
    authoredCursor,
  );

  const blankTextToken = await codec.issue(authoredCursor, { q: "  \t", place_id: "  " });
  assert.deepEqual((await codec.decode(blankTextToken.token, {})).cursor, authoredCursor);
  assert.deepEqual((await codec.decode(blankTextToken.token, { q: "", place_id: "" })).cursor, authoredCursor);
});

test("rejects changed effective filters and leaves page size outside the token inputs", async () => {
  const key = await generateTestKey();
  const codec = makeCodec(key, () => nowAtIssue);
  const filters: PublicEventListFilters = { lifecycle: "ongoing", q: "  heavy rain " };
  const issued = await codec.issue(authoredCursor, filters);

  // The codec accepts no page-size input, so its same cursor/filter inputs issue the same token.
  assert.equal((await codec.issue(authoredCursor, filters)).token, issued.token);
  assert.deepEqual((await codec.decode(issued.token, { lifecycle: "ongoing", q: "heavy rain" })).cursor, authoredCursor);
  await assertCodecError(
    codec.decode(issued.token, { lifecycle: "resolved", q: "heavy rain" }),
    "CURSOR_FILTER_MISMATCH",
  );
});

test("expires the cursor at the exact expiry instant", async () => {
  const key = await generateTestKey();
  let now = nowAtIssue;
  const codec = makeCodec(key, () => now);
  const issued = await codec.issue(authoredCursor);
  now = Date.parse(issued.expiresAt) - 1;
  assert.deepEqual((await codec.decode(issued.token)).cursor, authoredCursor);
  now = Date.parse(issued.expiresAt);
  await assertCodecError(codec.decode(issued.token), "CURSOR_EXPIRED");
});

test("rejects malformed, tampered, overlong, and unknown-version tokens with redacted errors", async () => {
  const key = await generateTestKey();
  const codec = makeCodec(key, () => nowAtIssue);
  const issued = await codec.issue(authoredCursor, { q: "private query marker" });
  const [version, encodedPayload, encodedSignature] = issued.token.split(".");
  const signature = decodeBase64Url(encodedSignature!);
  signature[0] ^= 0x01;
  const tamperedSignature = `${version}.${encodedPayload}.${encodeBase64Url(signature)}`;
  const payload = await getPayload(issued.token);
  payload.eventId = "tampered-event-id";
  const tamperedPayload = `${version}.${encodeBase64Url(new TextEncoder().encode(JSON.stringify(payload)))}.${encodedSignature}`;

  const badTokens = [
    "",
    "v1.!invalid!.AAAA",
    `v2.${encodedPayload}.${encodedSignature}`,
    tamperedPayload,
    tamperedSignature,
    "x".repeat(PUBLIC_EVENT_LIST_CURSOR_TOKEN_MAX_LENGTH + 1),
  ];
  for (const token of badTokens) {
    await assertCodecError(codec.decode(token), "INVALID_CURSOR", ["private query marker", "tampered-event-id"]);
  }
});

test("requires exact authenticated payload keys and a valid keyset", async () => {
  const key = await generateTestKey();
  const codec = makeCodec(key, () => nowAtIssue);
  const issuedPayload = await getPayload((await codec.issue(authoredCursor)).token);

  await assertCodecError(
    codec.decode(await signAuthoredPayload(key, { ...issuedPayload, extra: "secret extra" })),
    "INVALID_CURSOR",
    ["secret extra"],
  );
  const { filterBinding: _filterBinding, ...missingBinding } = issuedPayload;
  await assertCodecError(codec.decode(await signAuthoredPayload(key, missingBinding)), "INVALID_CURSOR");
  await assertCodecError(
    codec.decode(await signAuthoredPayload(key, {
      ...issuedPayload,
      firstPublishedAt: "2026-02-30T03:12:13.123456Z",
    })),
    "INVALID_CURSOR",
  );
  await assertCodecError(
    codec.decode(await signAuthoredPayload(key, { ...issuedPayload, eventId: "invalid event id" })),
    "INVALID_CURSOR",
  );
});

test("rejects invalid cursors and filters without exposing their contents", async () => {
  const key = await generateTestKey();
  const codec = makeCodec(key, () => nowAtIssue);
  const malformedCursor = { firstPublishedAt: authoredCursor.firstPublishedAt, eventId: "private event id value" };
  await assertCodecError(
    codec.issue(malformedCursor as PublicEventListCursor),
    "INVALID_CURSOR",
    ["private event id value"],
  );
  await assertCodecError(
    codec.issue(authoredCursor, { unexpected: "private-filter-value" } as PublicEventListFilters),
    "INVALID_CURSOR",
    ["private-filter-value"],
  );
});

test("keeps tokens under 2,048 characters for maximum accepted keyset and filter values", async () => {
  const key = await generateTestKey();
  const codec = makeCodec(key, () => nowAtIssue);
  const issued = await codec.issue({
    firstPublishedAt: authoredCursor.firstPublishedAt,
    eventId: `A${"b".repeat(127)}`,
  }, {
    category: "disasters_weather",
    lifecycle: "ongoing",
    freshness: "current",
    from: "2026-01-01T00:00:00Z",
    to: "2026-04-01T00:00:00Z",
    q: "q".repeat(120),
    place_id: "p".repeat(128),
  });
  assert.equal(issued.token.length <= PUBLIC_EVENT_LIST_CURSOR_TOKEN_MAX_LENGTH, true);
  assert.deepEqual((await codec.decode(issued.token, {
    category: "disasters_weather",
    lifecycle: "ongoing",
    freshness: "current",
    from: "2026-01-01T00:00:00Z",
    to: "2026-04-01T00:00:00Z",
    q: "q".repeat(120),
    place_id: "p".repeat(128),
  })).cursor.eventId, `A${"b".repeat(127)}`);
});