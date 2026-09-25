import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { EvidenceChunkInput as L2EvidenceChunkInput } from "../src/layers/l2-model-grounding/contracts.js";
import {
  CHUNK_MAX_CODE_POINTS,
  CHUNK_OVERLAP_CODE_POINTS,
  chunkPreparedText,
} from "../src/layers/l1-data-knowledge/evidence-chunking.js";
import { NORMALIZATION_VERSION, preparePermittedText } from "../src/layers/l1-data-knowledge/text-preparation.js";

test("normalizes Unicode and line endings with exact UTF-8 hashes", async () => {
  const prepared = await preparePermittedText("Cafe\u0301\r\nemoji 😀\rend");
  assert.equal(prepared.permittedText, "Café\nemoji 😀\nend");
  assert.equal(prepared.normalizationVersion, NORMALIZATION_VERSION);
  assert.equal(prepared.sourceInputHash, sha256("Cafe\u0301\r\nemoji 😀\rend"));
  assert.equal(prepared.permittedTextHash, sha256(prepared.permittedText));
  assert.deepEqual(prepared.redactions, { email: 0, indonesianMobile: 0 });
});

test("redacts only matched synthetic contact patterns and returns counts without values", async () => {
  const email = "fixture.person@example.test";
  const phone = "+62 812-3456-7890";
  const prepared = await preparePermittedText(`Synthetic contacts: ${email}; ${phone}.`);

  assert.equal(prepared.permittedText, "Synthetic contacts: [REDACTED:email]; [REDACTED:indonesian-mobile].");
  assert.deepEqual(prepared.redactions, { email: 1, indonesianMobile: 1 });
  assert.equal(prepared.permittedText.includes(email), false);
  assert.equal(prepared.permittedText.includes(phone), false);
  assert.equal(JSON.stringify(prepared.redactions).includes(email), false);
  assert.equal(JSON.stringify(prepared.redactions).includes(phone), false);
});

test("chunking is deterministic, bounded, and uses code-point spans with declared overlap", async () => {
  const source = `${"x".repeat(3_580)}😀e\u0301${"y".repeat(5_000)}`;
  const prepared = await preparePermittedText(source);
  const chunks = await chunkPreparedText("synthetic", "revision-synthetic-chunks", prepared);
  const repeated = await chunkPreparedText("synthetic", "revision-synthetic-chunks", prepared);
  const points = Array.from(prepared.permittedText);

  assert.deepEqual(repeated, chunks);
  assert.equal(chunks.length, 3);
  assert.equal(chunks[0]?.spanStart, 0);
  assert.equal(chunks.at(-1)?.spanEnd, points.length);
  assert.notEqual(chunks[0]?.chunkId, (await chunkPreparedText("historical", "revision-synthetic-chunks", prepared))[0]?.chunkId);
  const l2Input: L2EvidenceChunkInput = chunks[0]!;
  assert.equal(l2Input.text, chunks[0]?.text);

  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index]!;
    assert.equal(chunk.offsetUnit, "unicode_code_points");
    assert.equal(chunk.normalizationVersion, NORMALIZATION_VERSION);
    assert.equal(chunk.spanEnd - chunk.spanStart, Array.from(chunk.text).length);
    assert.ok(Array.from(chunk.text).length <= CHUNK_MAX_CODE_POINTS);
    assert.equal(chunk.text, points.slice(chunk.spanStart, chunk.spanEnd).join(""));
    assert.equal(chunk.chunkTextHash, sha256(chunk.text));
    assert.match(chunk.chunkId, /^chunk-[a-f0-9]{64}$/);
    assert.equal(chunk.chunkerVersion, "fixed-code-point-overlap-v1");
    if (index > 0) {
      const previous = chunks[index - 1]!;
      assert.equal(previous.spanEnd - chunk.spanStart, CHUNK_OVERLAP_CODE_POINTS);
      assert.equal(chunk.spanStart < previous.spanEnd, true);
    }
  }
});

test("preparation and chunking reject oversized or mismatched inputs before work grows unbounded", async () => {
  await assert.rejects(preparePermittedText("x".repeat(200_001)), /text preparation limit/);
  const prepared = await preparePermittedText("Synthetic fixture text.");
  await assert.rejects(
    chunkPreparedText("synthetic", "revision-synthetic-chunks", {
      ...prepared,
      permittedTextHash: "0".repeat(64),
    }),
    /hash does not match/,
  );
  await assert.rejects(
    preparePermittedText("invalid surrogate \ud800"),
    /invalid Unicode/,
  );
});

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
