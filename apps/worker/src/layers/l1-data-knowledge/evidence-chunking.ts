import { NORMALIZATION_VERSION, type PreparedText } from "./text-preparation.js";

export const CHUNKER_VERSION = "fixed-code-point-overlap-v1";
export const CHUNK_MAX_CODE_POINTS = 4_096;
export const CHUNK_OVERLAP_CODE_POINTS = 512;
export const MAX_EVIDENCE_CHUNKS = 1_024;

/** Structurally matches L2 EvidenceChunkInput without importing or invoking L2. */
export interface EvidenceChunkInput {
  readonly chunkId: string;
  readonly reportRevisionId: string;
  readonly permittedTextHash: string;
  readonly normalizationVersion: string;
  readonly spanStart: number;
  readonly spanEnd: number;
  readonly offsetUnit: "unicode_code_points";
  readonly chunkTextHash: string;
  readonly text: string;
  readonly chunkerVersion: string;
}

export interface ChunkingInput {
  readonly datasetKind: "live" | "historical" | "synthetic";
  readonly reportRevisionId: string;
  readonly permittedTextHash: string;
  readonly normalizationVersion: string;
  readonly permittedText: string;
}

/** Split exact normalized permitted text with fixed size and deterministic overlap. */
export async function chunkPermittedText(
  input: ChunkingInput,
): Promise<readonly EvidenceChunkInput[]> {
  if (!isId(input.reportRevisionId)) throw new Error("Invalid report revision ID");
  if (!isHash(input.permittedTextHash)) throw new Error("Invalid permitted text hash");
  if (input.normalizationVersion !== NORMALIZATION_VERSION) throw new Error("Unsupported normalization version");
  if (!isDatasetKind(input.datasetKind)) throw new Error("Invalid dataset kind");

  const codePoints = Array.from(input.permittedText);
  if (codePoints.length === 0) throw new Error("Cannot chunk empty permitted text");
  if (codePoints.length > 200_000) throw new Error("Permitted text exceeds the chunking limit");
  if (await sha256Utf8(input.permittedText) !== input.permittedTextHash) {
    throw new Error("Permitted text hash does not match the exact text");
  }

  const chunks: EvidenceChunkInput[] = [];
  let start = 0;
  while (start < codePoints.length) {
    const end = Math.min(start + CHUNK_MAX_CODE_POINTS, codePoints.length);
    const text = codePoints.slice(start, end).join("");
    const chunkTextHash = await sha256Utf8(text);
    const chunkId = `chunk-${await sha256Utf8(JSON.stringify([
      input.datasetKind,
      input.reportRevisionId,
      input.permittedTextHash,
      input.normalizationVersion,
      CHUNKER_VERSION,
      start,
      end,
      chunkTextHash,
    ]))}`;
    chunks.push({
      chunkId,
      reportRevisionId: input.reportRevisionId,
      permittedTextHash: input.permittedTextHash,
      normalizationVersion: input.normalizationVersion,
      spanStart: start,
      spanEnd: end,
      offsetUnit: "unicode_code_points",
      chunkTextHash,
      text,
      chunkerVersion: CHUNKER_VERSION,
    });
    if (chunks.length > MAX_EVIDENCE_CHUNKS) throw new Error("Chunk count exceeds the chunking limit");
    if (end === codePoints.length) break;
    start = end - CHUNK_OVERLAP_CODE_POINTS;
  }
  return chunks;
}

/** Convenience adapter from the output of the deterministic text transform. */
export function chunkPreparedText(
  datasetKind: ChunkingInput["datasetKind"],
  reportRevisionId: string,
  prepared: PreparedText,
): Promise<readonly EvidenceChunkInput[]> {
  return chunkPermittedText({
    datasetKind,
    reportRevisionId,
    permittedTextHash: prepared.permittedTextHash,
    normalizationVersion: prepared.normalizationVersion,
    permittedText: prepared.permittedText,
  });
}

function isDatasetKind(value: string): value is ChunkingInput["datasetKind"] {
  return value === "live" || value === "historical" || value === "synthetic";
}

function isHash(value: string): boolean {
  return /^[a-f0-9]{64}$/.test(value);
}

function isId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
}

async function sha256Utf8(value: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error("SHA-256 is unavailable in this runtime");
  const digest = await subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
