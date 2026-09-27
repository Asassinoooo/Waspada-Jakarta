import assert from "node:assert/strict";
import test from "node:test";
import {
  createPublicEventUpdatesCursorCodec,
  PUBLIC_EVENT_UPDATES_CURSOR_TOKEN_MAX_LENGTH,
  PUBLIC_EVENT_UPDATES_CURSOR_TTL_MS,
  PublicEventUpdatesCursorCodecError,
  type PublicEventUpdatesCursorCodec,
} from "../src/layers/l4-application-integration/public-event-updates-cursor.js";

const issuedAt = Date.parse("2026-09-27T04:00:00.000Z");
const signatureDomain = "waspada.public-event-updates.cursor.signature.v1\u0000";
const eventListSignatureDomain = "waspada.public-event-list.cursor.signature.v1\u0000";
const largeSequence = "9007199254740993";

async function generateTestKey(usages: KeyUsage[] = ["sign", "verify"]): Promise<CryptoKey> {
  return await globalThis.crypto.subtle.generateKey(
    { name: "HMAC", hash: "SHA-256" },
    false,
    usages,
  );
}

function makeCodec(key: CryptoKey, now: () => number): PublicEventUpdatesCursorCodec {
  return createPublicEventUpdatesCursorCodec({ key, now });
}

async function assertCodecError(
  promise: Promise<unknown>,
  code: "INVALID_CURSOR" | "CURSOR_EXPIRED" | "CURSOR_ISSUE_FAILED",
  sensitiveValues: readonly string[] = [],
): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof PublicEventUpdatesCursorCodecError);
    assert.equal(error.code, code);
    assert.equal(error.message.length < 100, true);
    for (const value of sensitiveValues) if (value.length > 0) assert.equal(error.message.includes(value), false);
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

async function signRawPayload(
  key: CryptoKey,
  payloadText: string,
  domain: string = signatureDomain,
): Promise<string> {
  const payloadEncoded = encodeBase64Url(new TextEncoder().encode(payloadText));
  const tokenPrefix = "v1." + payloadEncoded;
  const signature = await globalThis.crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(domain + tokenPrefix + "."),
  );
  return tokenPrefix + "." + encodeBase64Url(new Uint8Array(signature));
}

async function signPayload(key: CryptoKey, payload: unknown, domain?: string): Promise<string> {
  return signRawPayload(key, JSON.stringify(payload), domain);
}

async function decodePayload(token: string): Promise<Record<string, unknown>> {
  const encoded = token.split(".")[1]!;
  return JSON.parse(new TextDecoder().decode(decodeBase64Url(encoded))) as Record<string, unknown>;
}

test("issues the exact live payload with a decimal string and a 30-day expiry", async () => {
  const key = await generateTestKey();
  const codec = makeCodec(key, () => issuedAt);
  const issued = await codec.issue(largeSequence);
  const decoded = await codec.decode(issued.token);
  const payload = await decodePayload(issued.token);

  assert.deepEqual(decoded, {
    sequence: largeSequence,
    expiresAt: new Date(issuedAt + 30 * 24 * 60 * 60 * 1_000).toISOString(),
  });
  assert.deepEqual(Object.keys(payload).sort(), ["dataset", "expires_at", "sequence"]);
  assert.deepEqual(payload, {
    dataset: "live",
    sequence: largeSequence,
    expires_at: new Date(issuedAt + PUBLIC_EVENT_UPDATES_CURSOR_TTL_MS).toISOString(),
  });
  assert.equal(issued.expiresAt, payload.expires_at);
  assert.equal(issued.token.length <= PUBLIC_EVENT_UPDATES_CURSOR_TOKEN_MAX_LENGTH, true);
  assert.match(issued.token, /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u);
});

test("expires at the exact 30-day boundary", async () => {
  const key = await generateTestKey();
  let now = issuedAt;
  const codec = makeCodec(key, () => now);
  const issued = await codec.issue("10");

  now = Date.parse(issued.expiresAt) - 1;
  assert.equal((await codec.decode(issued.token)).sequence, "10");
  now = Date.parse(issued.expiresAt);
  await assertCodecError(codec.decode(issued.token), "CURSOR_EXPIRED");
});

test("rejects malformed, tampered, noncanonical, wrong-scope, and cross-domain tokens", async () => {
  const key = await generateTestKey();
  const codec = makeCodec(key, () => issuedAt);
  const issued = await codec.issue("10");
  const [version, encodedPayload, encodedSignature] = issued.token.split(".");

  const tamperedSignature = decodeBase64Url(encodedSignature!);
  tamperedSignature[0] ^= 0x01;
  const tamperedPayloadValue = await decodePayload(issued.token);
  tamperedPayloadValue.sequence = "11";
  const tamperedPayload = version + "."
    + encodeBase64Url(new TextEncoder().encode(JSON.stringify(tamperedPayloadValue)))
    + "." + encodedSignature;

  const invalidPayloads = [
    JSON.stringify({ dataset: "synthetic", sequence: "10", expires_at: issued.expiresAt }),
    JSON.stringify({ dataset: "live", sequence: "00", expires_at: issued.expiresAt }),
    JSON.stringify({ dataset: "live", sequence: "9223372036854775808", expires_at: issued.expiresAt }),
    JSON.stringify({ dataset: "live", sequence: 10, expires_at: issued.expiresAt }),
    JSON.stringify({ dataset: "live", sequence: "10", expires_at: "2026-02-30T04:00:00.000Z" }),
    JSON.stringify({ dataset: "live", sequence: "10", expires_at: "0001-02-29T04:00:00.000Z" }),
    JSON.stringify({ dataset: "live", sequence: "10", expires_at: issued.expiresAt, extra: "private-field" }),
    "{ \"dataset\":\"live\",\"sequence\":\"10\",\"expires_at\":\""
      + issued.expiresAt + "\" }",
  ];
  const invalidTokens = [
    "",
    "v1.!invalid!.AAAA",
    "v2." + encodedPayload + "." + encodedSignature,
    tamperedPayload,
    version + "." + encodedPayload + "." + encodeBase64Url(tamperedSignature),
    "x".repeat(PUBLIC_EVENT_UPDATES_CURSOR_TOKEN_MAX_LENGTH + 1),
    await signPayload(key, { dataset: "synthetic", sequence: "10", expires_at: issued.expiresAt }),
    await signRawPayload(key, invalidPayloads[1]!),
    await signRawPayload(key, invalidPayloads[2]!),
    await signRawPayload(key, invalidPayloads[3]!),
    await signRawPayload(key, invalidPayloads[4]!),
    await signRawPayload(key, invalidPayloads[5]!),
    await signRawPayload(key, invalidPayloads[6]!),
    await signPayload(
      key,
      { dataset: "live", sequence: "10", expires_at: issued.expiresAt },
      eventListSignatureDomain,
    ),
  ];

  for (const token of invalidTokens) {
    await assertCodecError(codec.decode(token), "INVALID_CURSOR", [
      token,
      "private-field",
      "9223372036854775808",
    ]);
  }
});

test("maps invalid sequences and Web Crypto signing failures to a fixed issue error", async () => {
  const regularKey = await generateTestKey();
  const codec = makeCodec(regularKey, () => issuedAt);
  await assertCodecError(codec.issue(10), "CURSOR_ISSUE_FAILED", ["10"]);
  await assertCodecError(codec.issue("9223372036854775808"), "CURSOR_ISSUE_FAILED", [
    "9223372036854775808",
  ]);

  const verifyOnlyKey = await generateTestKey(["verify"]);
  await assertCodecError(makeCodec(verifyOnlyKey, () => issuedAt).issue("10"), "CURSOR_ISSUE_FAILED");
});

test("uses distinct signature domain from the event-list cursor", async () => {
  const key = await generateTestKey();
  const codec = makeCodec(key, () => issuedAt);
  const eventListSignedToken = await signPayload(
    key,
    { dataset: "live", sequence: "10", expires_at: new Date(issuedAt + PUBLIC_EVENT_UPDATES_CURSOR_TTL_MS).toISOString() },
    eventListSignatureDomain,
  );

  await assertCodecError(codec.decode(eventListSignedToken), "INVALID_CURSOR");
});
