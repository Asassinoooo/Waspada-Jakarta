import { MAX_PERMITTED_TEXT_CODE_POINTS, NORMALIZATION_VERSION } from "./text-preparation.js";

export type LocationCandidateDatasetKind = "live" | "historical" | "synthetic";

export interface LocationCandidateTextInput {
  readonly datasetKind: LocationCandidateDatasetKind;
  readonly reportRevisionId: string;
  readonly permittedTextHash: string;
  readonly normalizationVersion: string;
  readonly permittedText: string;
}

export interface LocationCandidateGazetteerPlace {
  readonly placeId: string;
  readonly aliases: readonly string[];
}

export interface LocationCandidateGazetteerSnapshot {
  readonly datasetKind: LocationCandidateDatasetKind;
  readonly snapshotId: string;
  readonly snapshotVersion: string;
  readonly places: readonly LocationCandidateGazetteerPlace[];
}

export interface LocationCandidateMatch {
  readonly spanStart: number;
  readonly spanEnd: number;
  readonly offsetUnit: "unicode_code_points";
  readonly placeIds: readonly string[];
}

export interface CompleteLocationCandidateResult {
  readonly status: "complete";
  readonly datasetKind: LocationCandidateDatasetKind;
  readonly reportRevisionId: string;
  readonly permittedTextHash: string;
  readonly normalizationVersion: string;
  readonly snapshotId: string;
  readonly snapshotVersion: string;
  /** Empty means no phrase produced a candidate; it makes no claim about coverage or safety. */
  readonly matches: readonly LocationCandidateMatch[];
}

export const LOCATION_CANDIDATE_LIMITS = Object.freeze({
  textCodePoints: MAX_PERMITTED_TEXT_CODE_POINTS,
  placeCount: 500,
  aliasCount: 10_000,
  totalAliasTokens: 20_000,
  aliasCodePoints: 256,
  aliasTokens: 16,
  emittedMatches: 512,
  emittedPlaceIds: 4_096,
});

export type LocationCandidateErrorCode =
  | "INVALID_TEXT"
  | "TEXT_LIMIT_EXCEEDED"
  | "TEXT_HASH_MISMATCH"
  | "INVALID_SNAPSHOT"
  | "SNAPSHOT_LIMIT_EXCEEDED"
  | "DATASET_MISMATCH"
  | "HASH_UNAVAILABLE"
  | "OUTPUT_LIMIT_EXCEEDED";

export type LocationCandidateResult =
  | CompleteLocationCandidateResult
  | { readonly status: "error"; readonly code: Exclude<LocationCandidateErrorCode, "OUTPUT_LIMIT_EXCEEDED"> }
  | { readonly status: "unavailable"; readonly code: "OUTPUT_LIMIT_EXCEEDED" };

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const DATASET_KINDS = new Set<LocationCandidateDatasetKind>(["live", "historical", "synthetic"]);
const TOKEN_CHARACTER = /^[\p{L}\p{N}\p{M}_]$/u;

interface Token {
  readonly key: string;
  readonly start: number;
  readonly end: number;
}

interface ValidatedText extends LocationCandidateTextInput {}

interface ValidatedSnapshot {
  readonly datasetKind: LocationCandidateDatasetKind;
  readonly snapshotId: string;
  readonly snapshotVersion: string;
  readonly aliases: readonly { readonly placeId: string; readonly tokens: readonly string[] }[];
}

interface TrieNode {
  readonly children: Map<string, TrieNode>;
  readonly placeIds: Set<string>;
}

class CandidateValidationError extends Error {
  constructor(readonly code: LocationCandidateErrorCode) {
    super(code);
  }
}

function invalid(code: LocationCandidateErrorCode): never {
  throw new CandidateValidationError(code);
}

/**
 * Match complete Unicode word-token phrases in exact prepared text. The input
 * is never normalized or rewritten, and every returned span uses code points.
 */
export async function matchLocationCandidates(
  textValue: unknown,
  snapshotValue: unknown,
): Promise<LocationCandidateResult> {
  let text: ValidatedText;
  let snapshot: ValidatedSnapshot;
  try {
    text = validateText(textValue);
    snapshot = validateSnapshot(snapshotValue);
  } catch (cause) {
    const code = cause instanceof CandidateValidationError ? cause.code : "INVALID_TEXT";
    return code === "OUTPUT_LIMIT_EXCEEDED"
      ? { status: "unavailable", code }
      : { status: "error", code };
  }

  if (text.datasetKind !== snapshot.datasetKind) return { status: "error", code: "DATASET_MISMATCH" };

  let textHash: string | null;
  try {
    textHash = await sha256Utf8(text.permittedText);
  } catch {
    textHash = null;
  }
  if (textHash === null) return { status: "error", code: "HASH_UNAVAILABLE" };
  if (textHash !== text.permittedTextHash) return { status: "error", code: "TEXT_HASH_MISMATCH" };

  const tokens = tokenize(text.permittedText);
  const trie = buildTrie(snapshot.aliases);
  const matches = new Map<string, { readonly spanStart: number; readonly spanEnd: number; readonly placeIds: Set<string> }>();
  let emittedPlaceIds = 0;

  for (let start = 0; start < tokens.length; start += 1) {
    let node = trie;
    const tokenStart = tokens[start]!;
    const lastToken = Math.min(tokens.length, start + LOCATION_CANDIDATE_LIMITS.aliasTokens);
    for (let index = start; index < lastToken; index += 1) {
      const token = tokens[index]!;
      const next = node.children.get(token.key);
      if (!next) break;
      node = next;
      if (node.placeIds.size === 0) continue;

      const key = `${tokenStart.start}:${token.end}`;
      let match = matches.get(key);
      if (!match) {
        if (matches.size >= LOCATION_CANDIDATE_LIMITS.emittedMatches) {
          return { status: "unavailable", code: "OUTPUT_LIMIT_EXCEEDED" };
        }
        match = { spanStart: tokenStart.start, spanEnd: token.end, placeIds: new Set<string>() };
        matches.set(key, match);
      }

      for (const placeId of node.placeIds) {
        if (match.placeIds.has(placeId)) continue;
        if (emittedPlaceIds >= LOCATION_CANDIDATE_LIMITS.emittedPlaceIds) {
          return { status: "unavailable", code: "OUTPUT_LIMIT_EXCEEDED" };
        }
        match.placeIds.add(placeId);
        emittedPlaceIds += 1;
      }
    }
  }

  const orderedMatches = [...matches.values()]
    .sort((left, right) => left.spanStart - right.spanStart || left.spanEnd - right.spanEnd)
    .map((match): LocationCandidateMatch => ({
      spanStart: match.spanStart,
      spanEnd: match.spanEnd,
      offsetUnit: "unicode_code_points",
      placeIds: [...match.placeIds].sort(compareIds),
    }));

  return {
    status: "complete",
    datasetKind: text.datasetKind,
    reportRevisionId: text.reportRevisionId,
    permittedTextHash: text.permittedTextHash,
    normalizationVersion: text.normalizationVersion,
    snapshotId: snapshot.snapshotId,
    snapshotVersion: snapshot.snapshotVersion,
    matches: orderedMatches,
  };
}

function validateText(value: unknown): ValidatedText {
  const record = exactRecord(
    value,
    ["datasetKind", "reportRevisionId", "permittedTextHash", "normalizationVersion", "permittedText"],
    "INVALID_TEXT",
  );
  if (!isDatasetKind(record.datasetKind)) invalid("INVALID_TEXT");
  if (!isId(record.reportRevisionId) || typeof record.permittedTextHash !== "string" || !HASH_PATTERN.test(record.permittedTextHash)) {
    invalid("INVALID_TEXT");
  }
  if (record.normalizationVersion !== NORMALIZATION_VERSION || typeof record.permittedText !== "string") invalid("INVALID_TEXT");

  const length = boundedCodePointLength(record.permittedText, LOCATION_CANDIDATE_LIMITS.textCodePoints);
  if (length === "invalid") invalid("INVALID_TEXT");
  if (length === "limit") invalid("TEXT_LIMIT_EXCEEDED");

  return {
    datasetKind: record.datasetKind,
    reportRevisionId: record.reportRevisionId,
    permittedTextHash: record.permittedTextHash,
    normalizationVersion: record.normalizationVersion,
    permittedText: record.permittedText,
  };
}

function validateSnapshot(value: unknown): ValidatedSnapshot {
  const record = exactRecord(
    value,
    ["datasetKind", "snapshotId", "snapshotVersion", "places"],
    "INVALID_SNAPSHOT",
  );
  if (!isDatasetKind(record.datasetKind) || !isId(record.snapshotId) || !isId(record.snapshotVersion)) {
    invalid("INVALID_SNAPSHOT");
  }
  const places = boundedArray(record.places, LOCATION_CANDIDATE_LIMITS.placeCount, "SNAPSHOT_LIMIT_EXCEEDED");
  const placeIds = new Set<string>();
  const aliases: { placeId: string; tokens: readonly string[] }[] = [];
  let aliasCount = 0;
  let totalAliasTokens = 0;

  for (const placeValue of places) {
    const place = exactRecord(placeValue, ["placeId", "aliases"], "INVALID_SNAPSHOT");
    if (!isId(place.placeId) || placeIds.has(place.placeId)) invalid("INVALID_SNAPSHOT");
    placeIds.add(place.placeId);
    const placeAliases = boundedArray(place.aliases, LOCATION_CANDIDATE_LIMITS.aliasCount, "SNAPSHOT_LIMIT_EXCEEDED", 1);

    for (const aliasValue of placeAliases) {
      aliasCount += 1;
      if (aliasCount > LOCATION_CANDIDATE_LIMITS.aliasCount) invalid("SNAPSHOT_LIMIT_EXCEEDED");
      if (typeof aliasValue !== "string") invalid("INVALID_SNAPSHOT");
      const aliasLength = boundedCodePointLength(aliasValue, LOCATION_CANDIDATE_LIMITS.aliasCodePoints);
      if (aliasLength === "invalid") invalid("INVALID_SNAPSHOT");
      if (aliasLength === "limit") invalid("SNAPSHOT_LIMIT_EXCEEDED");

      const aliasTokens = tokenize(aliasValue).map((token) => token.key);
      if (aliasTokens.length === 0) invalid("INVALID_SNAPSHOT");
      if (aliasTokens.length > LOCATION_CANDIDATE_LIMITS.aliasTokens) invalid("SNAPSHOT_LIMIT_EXCEEDED");
      totalAliasTokens += aliasTokens.length;
      if (totalAliasTokens > LOCATION_CANDIDATE_LIMITS.totalAliasTokens) invalid("SNAPSHOT_LIMIT_EXCEEDED");
      aliases.push({ placeId: place.placeId, tokens: aliasTokens });
    }
  }

  return {
    datasetKind: record.datasetKind,
    snapshotId: record.snapshotId,
    snapshotVersion: record.snapshotVersion,
    aliases,
  };
}

function exactRecord(value: unknown, keys: readonly string[], errorCode: "INVALID_TEXT" | "INVALID_SNAPSHOT"): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid(errorCode);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalid(errorCode);

  const actualKeys = Reflect.ownKeys(value);
  if (actualKeys.length !== keys.length || actualKeys.some((key) => typeof key !== "string" || !keys.includes(key))) {
    invalid(errorCode);
  }
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) invalid(errorCode);
  }
  return value as Record<string, unknown>;
}

function boundedArray(
  value: unknown,
  maximum: number,
  errorCode: "INVALID_SNAPSHOT" | "SNAPSHOT_LIMIT_EXCEEDED",
  minimum = 0,
): readonly unknown[] {
  if (!Array.isArray(value)) invalid("INVALID_SNAPSHOT");
  if (value.length < minimum) invalid("INVALID_SNAPSHOT");
  if (value.length > maximum) invalid(errorCode === "INVALID_SNAPSHOT" ? errorCode : "SNAPSHOT_LIMIT_EXCEEDED");

  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== value.length + 1 || ownKeys.some((key) => key !== "length" && (typeof key !== "string" || !/^(0|[1-9]\d*)$/.test(key)))) {
    invalid("INVALID_SNAPSHOT");
  }
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) invalid("INVALID_SNAPSHOT");
  }
  return value;
}

function boundedCodePointLength(value: string, maximum: number): number | "invalid" | "limit" {
  let count = 0;
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return "invalid";
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return "invalid";
    }
    count += 1;
    if (count > maximum) return "limit";
  }
  return count;
}

function tokenize(value: string): Token[] {
  const tokens: Token[] = [];
  let current = "";
  let tokenStart = 0;
  let offset = 0;
  for (const character of value) {
    if (TOKEN_CHARACTER.test(character)) {
      if (current.length === 0) tokenStart = offset;
      current += character;
    } else if (current.length > 0) {
      tokens.push({ key: canonicalize(current), start: tokenStart, end: offset });
      current = "";
    }
    offset += 1;
  }
  if (current.length > 0) tokens.push({ key: canonicalize(current), start: tokenStart, end: offset });
  return tokens;
}

function canonicalize(token: string): string {
  // Locale-independent lowercase plus the Unicode final-sigma equivalence.
  return token.toLowerCase().replace(/\u03c2/gu, "\u03c3");
}

function buildTrie(aliases: ValidatedSnapshot["aliases"]): TrieNode {
  const root = makeTrieNode();
  for (const alias of aliases) {
    let node = root;
    for (const token of alias.tokens) {
      let next = node.children.get(token);
      if (!next) {
        next = makeTrieNode();
        node.children.set(token, next);
      }
      node = next;
    }
    node.placeIds.add(alias.placeId);
  }
  return root;
}

function makeTrieNode(): TrieNode {
  return { children: new Map(), placeIds: new Set() };
}

function compareIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isDatasetKind(value: unknown): value is LocationCandidateDatasetKind {
  return typeof value === "string" && DATASET_KINDS.has(value as LocationCandidateDatasetKind);
}

function isId(value: unknown): value is string {
  return typeof value === "string" && ID_PATTERN.test(value);
}

async function sha256Utf8(value: string): Promise<string | null> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return null;
  const digest = await subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
