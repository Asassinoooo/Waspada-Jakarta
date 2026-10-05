import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  LOCATION_CANDIDATE_LIMITS,
  matchLocationCandidates,
  type LocationCandidateGazetteerPlace,
  type LocationCandidateGazetteerSnapshot,
  type LocationCandidateTextInput,
} from "../src/layers/l1-data-knowledge/location-candidates.js";
import { NORMALIZATION_VERSION } from "../src/layers/l1-data-knowledge/text-preparation.js";

test("matches complete case-insensitive phrases across punctuation and excludes word substrings", async () => {
  const text = "Flood at SYN. EXAMPLEWAY; near cASE FICTIONTON. Exampletown. ΣΥΝΤΕΣ.";
  const snapshot = gazetteer([
    { placeId: "place-synthetic-way", aliases: ["Syn Exampleway"] },
    { placeId: "place-synthetic-fictionton", aliases: ["Case \uFB01ctionton"] },
    { placeId: "place-example", aliases: ["Example"] },
    { placeId: "place-way", aliases: ["way"] },
    { placeId: "place-greek-fixture", aliases: ["συντεσ"] },
  ]);

  const result = await matchLocationCandidates(preparedText(text), snapshot);
  assert.equal(result.status, "complete");
  if (result.status !== "complete") return;
  assert.deepEqual(result.matches, [
    matchFor(text, "SYN. EXAMPLEWAY", ["place-synthetic-way"]),
    matchFor(text, "cASE FICTIONTON", ["place-synthetic-fictionton"]),
    matchFor(text, "ΣΥΝΤΕΣ", ["place-greek-fixture"]),
  ]);
});

test("uses exact Unicode code-point spans after non-BMP characters", async () => {
  const text = "😀🚧 Alert in ÉXAMPLEVILLE; Evacuate.";
  const result = await matchLocationCandidates(
    preparedText(text),
    gazetteer([{ placeId: "place-exampleville", aliases: ["éxampleville"] }, { placeId: "place-evacuation", aliases: ["evacuate"] }]),
  );

  assert.equal(result.status, "complete");
  if (result.status !== "complete") return;
  assert.deepEqual(result.matches, [
    matchFor(text, "ÉXAMPLEVILLE", ["place-exampleville"]),
    matchFor(text, "Evacuate", ["place-evacuation"]),
  ]);
  for (const match of result.matches) {
    assert.equal(codePoints(text).slice(match.spanStart, match.spanEnd).join(""),
      match.spanStart === matchFor(text, "ÉXAMPLEVILLE", ["place-exampleville"]).spanStart ? "ÉXAMPLEVILLE" : "Evacuate");
  }
});

test("preserves nested overlaps and ambiguity with stable order independent of catalog order", async () => {
  const text = "Sample Borough";
  const places: LocationCandidateGazetteerPlace[] = [
    { placeId: "place-synthetic-zeta", aliases: ["Sample Borough", "Borough"] },
    { placeId: "place-synthetic-beta", aliases: ["Sample", "Borough"] },
    { placeId: "place-synthetic-alpha", aliases: ["Sample Borough", "Sample"] },
  ];
  const first = await matchLocationCandidates(preparedText(text), gazetteer(places));
  const second = await matchLocationCandidates(preparedText(text), gazetteer([...places].reverse()));

  assert.deepEqual(first, second);
  assert.equal(first.status, "complete");
  if (first.status !== "complete") return;
  assert.deepEqual(first.matches, [
    matchFor(text, "Sample", ["place-synthetic-alpha", "place-synthetic-beta"]),
    matchFor(text, "Sample Borough", ["place-synthetic-alpha", "place-synthetic-zeta"]),
    matchFor(text, "Borough", ["place-synthetic-beta", "place-synthetic-zeta"]),
  ]);
});

test("returns identity with an empty candidate array and never echoes text, aliases, or geometry", async () => {
  const text = "No authored alias appears in this synthetic report.";
  const result = await matchLocationCandidates(
    preparedText(text),
    gazetteer([{ placeId: "place-synthetic-01", aliases: ["Fixture Sector"] }]),
  );

  assert.deepEqual(result, {
    status: "complete",
    datasetKind: "synthetic",
    reportRevisionId: "revision-synthetic-01",
    permittedTextHash: hash(text),
    normalizationVersion: NORMALIZATION_VERSION,
    snapshotId: "gazetteer-synthetic-01",
    snapshotVersion: "v1",
    matches: [],
  });
  assert.equal(JSON.stringify(result).includes(text), false);
  assert.equal(JSON.stringify(result).includes("Cempaka"), false);
  assert.equal("geometry" in result, false);
  assert.equal("coordinates" in result, false);
});

test("does not mutate frozen text or snapshot inputs", async () => {
  const text = deepFreeze(preparedText("Synthetic Mockshire report."));
  const snapshot = deepFreeze(gazetteer([{ placeId: "place-synthetic-river", aliases: ["Mockshire"] }]));
  const textBefore = structuredClone(text);
  const snapshotBefore = structuredClone(snapshot);

  const result = await matchLocationCandidates(text, snapshot);
  assert.equal(result.status, "complete");
  assert.deepEqual(text, textBefore);
  assert.deepEqual(snapshot, snapshotBefore);
});

test("rejects cross-dataset input and malformed or expanded snapshots with fixed codes", async () => {
  const text = preparedText("Sample Basin");
  const historicalSnapshot = { ...gazetteer([{ placeId: "place-synthetic-basin", aliases: ["Sample Basin"] }]), datasetKind: "historical" };
  assert.deepEqual(await matchLocationCandidates(text, historicalSnapshot), { status: "error", code: "DATASET_MISMATCH" });

  assert.deepEqual(
    await matchLocationCandidates(text, {
      ...gazetteer([{ placeId: "place-synthetic-basin", aliases: ["Sample Basin"] }]),
      places: [{ placeId: "place-synthetic-basin", aliases: ["Sample Basin"], coordinates: [106.0, -6.0] }],
    }),
    { status: "error", code: "INVALID_SNAPSHOT" },
  );
  assert.deepEqual(
    await matchLocationCandidates(text, gazetteer([{ placeId: "place-synthetic-basin", aliases: ["...---"] }])),
    { status: "error", code: "INVALID_SNAPSHOT" },
  );
  assert.deepEqual(
    await matchLocationCandidates({ ...text, unexpected: "field" }, gazetteer([])),
    { status: "error", code: "INVALID_TEXT" },
  );
});

test("rejects malformed prepared text and a hash that does not bind the exact text", async () => {
  const snapshot = gazetteer([{ placeId: "place-synthetic-basin", aliases: ["Sample Basin"] }]);
  assert.deepEqual(
    await matchLocationCandidates({ ...preparedText("Sample Basin"), normalizationVersion: "unknown" }, snapshot),
    { status: "error", code: "INVALID_TEXT" },
  );
  assert.deepEqual(
    await matchLocationCandidates({ ...preparedText("Sample Basin"), permittedTextHash: "0".repeat(64) }, snapshot),
    { status: "error", code: "TEXT_HASH_MISMATCH" },
  );
  assert.deepEqual(
    await matchLocationCandidates(preparedText("invalid \ud800"), snapshot),
    { status: "error", code: "INVALID_TEXT" },
  );
});

test("fails closed at the prepared-text code-point limit", async () => {
  const oversized = "x".repeat(LOCATION_CANDIDATE_LIMITS.textCodePoints + 1);
  assert.deepEqual(
    await matchLocationCandidates(preparedText(oversized), gazetteer([])),
    { status: "error", code: "TEXT_LIMIT_EXCEEDED" },
  );
});

test("bounds place count, alias count, total alias tokens, alias length, and alias token count", async () => {
  const text = preparedText("Synthetic report.");
  const tooManyPlaces = Array.from({ length: LOCATION_CANDIDATE_LIMITS.placeCount + 1 }, (_, index) => ({
    placeId: `place-${index}`,
    aliases: ["X"],
  }));
  assert.deepEqual(await matchLocationCandidates(text, gazetteer(tooManyPlaces)), {
    status: "error",
    code: "SNAPSHOT_LIMIT_EXCEEDED",
  });

  const tooManyAliases = Array.from({ length: LOCATION_CANDIDATE_LIMITS.aliasCount + 1 }, () => "x");
  assert.deepEqual(await matchLocationCandidates(text, gazetteer([{ placeId: "place-many-aliases", aliases: tooManyAliases }])), {
    status: "error",
    code: "SNAPSHOT_LIMIT_EXCEEDED",
  });

  const longAlias = "a".repeat(LOCATION_CANDIDATE_LIMITS.aliasCodePoints + 1);
  assert.deepEqual(await matchLocationCandidates(text, gazetteer([{ placeId: "place-long-alias", aliases: [longAlias] }])), {
    status: "error",
    code: "SNAPSHOT_LIMIT_EXCEEDED",
  });

  const tooManyAliasTokens = Array.from({ length: LOCATION_CANDIDATE_LIMITS.aliasTokens + 1 }, () => "x").join(" ");
  assert.deepEqual(await matchLocationCandidates(text, gazetteer([{ placeId: "place-many-tokens", aliases: [tooManyAliasTokens] }])), {
    status: "error",
    code: "SNAPSHOT_LIMIT_EXCEEDED",
  });

  const repeatedPhrase = Array.from({ length: LOCATION_CANDIDATE_LIMITS.aliasTokens }, (_, index) => `x${index}`).join(" ");
  const totalTokenOverflow = Array.from({ length: Math.floor(LOCATION_CANDIDATE_LIMITS.totalAliasTokens / LOCATION_CANDIDATE_LIMITS.aliasTokens) + 1 }, () => repeatedPhrase);
  assert.deepEqual(await matchLocationCandidates(text, gazetteer([{ placeId: "place-total-tokens", aliases: totalTokenOverflow }])), {
    status: "error",
    code: "SNAPSHOT_LIMIT_EXCEEDED",
  });
});

test("returns unavailable without partial output when either emitted-match bound is exceeded", async () => {
  const repeatedText = Array.from({ length: LOCATION_CANDIDATE_LIMITS.emittedMatches + 1 }, () => "x").join(" ");
  const onePlaceSnapshot = gazetteer([{ placeId: "place-x", aliases: ["x"] }]);
  assert.deepEqual(await matchLocationCandidates(preparedText(repeatedText), onePlaceSnapshot), {
    status: "unavailable",
    code: "OUTPUT_LIMIT_EXCEEDED",
  });

  const crowdedPlaces = Array.from({ length: LOCATION_CANDIDATE_LIMITS.placeCount }, (_, index) => ({
    placeId: `place-${String(index).padStart(3, "0")}`,
    aliases: ["x"],
  }));
  const repeatedCrowdedText = Array.from({ length: Math.ceil(LOCATION_CANDIDATE_LIMITS.emittedPlaceIds / LOCATION_CANDIDATE_LIMITS.placeCount) + 1 }, () => "x").join(" ");
  assert.deepEqual(await matchLocationCandidates(preparedText(repeatedCrowdedText), gazetteer(crowdedPlaces)), {
    status: "unavailable",
    code: "OUTPUT_LIMIT_EXCEEDED",
  });
});

function preparedText(permittedText: string, datasetKind: LocationCandidateTextInput["datasetKind"] = "synthetic"): LocationCandidateTextInput {
  return {
    datasetKind,
    reportRevisionId: "revision-synthetic-01",
    permittedTextHash: hash(permittedText),
    normalizationVersion: NORMALIZATION_VERSION,
    permittedText,
  };
}

function gazetteer(places: readonly LocationCandidateGazetteerPlace[]): LocationCandidateGazetteerSnapshot {
  return {
    datasetKind: "synthetic",
    snapshotId: "gazetteer-synthetic-01",
    snapshotVersion: "v1",
    places,
  };
}

function matchFor(text: string, excerpt: string, placeIds: readonly string[]) {
  const utf16Index = text.indexOf(excerpt);
  assert.notEqual(utf16Index, -1, `Missing fixture excerpt: ${excerpt}`);
  const spanStart = codePoints(text.slice(0, utf16Index)).length;
  return {
    spanStart,
    spanEnd: spanStart + codePoints(excerpt).length,
    offsetUnit: "unicode_code_points" as const,
    placeIds,
  };
}

function codePoints(value: string): string[] {
  return Array.from(value);
}

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
