import assert from "node:assert/strict";
import { closeSync, ftruncateSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { exitCodeFor, MAX_CASEBOOK_BYTES, type CasebookCliResult } from "./casebook-cli.js";

const CLI_PATH = fileURLToPath(new URL("./casebook-cli.ts", import.meta.url));
const FIXTURE_PATH = fileURLToPath(new URL("../../docs/evaluation/fixtures/synthetic-casebook.json", import.meta.url));

function temporaryDirectory(context: TestContext): string {
  const path = mkdtempSync(join(tmpdir(), "casebook-cli-"));
  context.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}

function invoke(args: readonly string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", CLI_PATH, ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
}

function parseResult(stdout: string): CasebookCliResult {
  assert.ok(stdout.endsWith("\n"), "CLI result must end with one newline");
  const result: unknown = JSON.parse(stdout);
  assert.ok(result !== null && typeof result === "object" && !Array.isArray(result));
  assert.deepEqual(Object.keys(result), ["valid", "metadata_ready", "issue_codes", "readiness_reasons"]);
  return result as CasebookCliResult;
}

function assertErrorOutput(result: ReturnType<typeof invoke>, code: string, redactions: readonly string[] = []): void {
  assert.equal(result.status, 2);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, `${JSON.stringify({ error_code: code })}\n`);
  for (const secret of redactions) {
    assert.equal(result.stdout.includes(secret), false);
    assert.equal(result.stderr.includes(secret), false);
  }
}

test("usage failures are fixed, redacted, and return exit code 2", () => {
  assertErrorOutput(invoke([]), "USAGE");
  assertErrorOutput(invoke(["one-path", "extra-argument-sentinel"]), "USAGE", ["one-path", "extra-argument-sentinel"]);
});

test("local file read failures do not expose the path or platform error", (context) => {
  const directory = temporaryDirectory(context);
  const missingPath = join(directory, "private-path-sentinel.json");
  assertErrorOutput(invoke([missingPath]), "READ_ERROR", [missingPath, "private-path-sentinel"]);
});

test("files larger than 5 MiB are rejected before JSON parsing", (context) => {
  const directory = temporaryDirectory(context);
  const oversizedPath = join(directory, "oversized-path-sentinel.json");
  const descriptor = openSync(oversizedPath, "w");
  try {
    ftruncateSync(descriptor, MAX_CASEBOOK_BYTES + 1);
  } finally {
    closeSync(descriptor);
  }
  assertErrorOutput(invoke([oversizedPath]), "FILE_TOO_LARGE", [oversizedPath]);
});

test("malformed JSON and invalid UTF-8 use fixed redacted errors", (context) => {
  const directory = temporaryDirectory(context);
  const jsonPath = join(directory, "json-path-sentinel.json");
  const jsonSentinel = "json-content-sentinel";
  writeFileSync(jsonPath, `{ ${jsonSentinel}`, "utf8");
  assertErrorOutput(invoke([jsonPath]), "INVALID_JSON", [jsonPath, jsonSentinel]);

  const utf8Path = join(directory, "utf8-path-sentinel.json");
  writeFileSync(utf8Path, Buffer.from([0xff, 0xfe, 0xfd]));
  assertErrorOutput(invoke([utf8Path]), "INVALID_UTF8", [utf8Path]);
});

test("structural errors expose codes only and return exit code 2", (context) => {
  const directory = temporaryDirectory(context);
  const inputPath = join(directory, "invalid-path-sentinel.json");
  const input = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as Record<string, unknown>;
  const contentSentinel = "private-content-sentinel";
  input.private_metadata = contentSentinel;
  writeFileSync(inputPath, JSON.stringify(input), "utf8");

  const invocation = invoke([inputPath]);
  assert.equal(invocation.status, 2);
  assert.equal(invocation.stderr, "");
  const result = parseResult(invocation.stdout);
  assert.equal(result.valid, false);
  assert.equal(result.metadata_ready, false);
  assert.deepEqual(result.issue_codes, ["UNKNOWN_FIELD"]);
  assert.deepEqual(result.readiness_reasons, ["CASEBOOK_INVALID"]);
  for (const secret of [inputPath, "invalid-path-sentinel", contentSentinel]) {
    assert.equal(invocation.stdout.includes(secret), false);
    assert.equal(invocation.stderr.includes(secret), false);
  }
});

test("relative synthetic fixture is valid, not metadata-ready, and returns exit code 1", () => {
  const relativeFixturePath = "docs/evaluation/fixtures/synthetic-casebook.json";
  const fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as {
    casebook_id: string;
    cases: Array<{
      case_id: string;
      reports: Array<{ report_id: string; revision_id: string; content_hash: string; content_ref: string }>;
      independent_reviews: Array<{ reviewer_id: string }>;
    }>;
    sources: Array<{ source_id: string }>;
  };
  const invocation = invoke([relativeFixturePath]);
  assert.equal(invocation.status, 1);
  assert.equal(invocation.stderr, "");
  const result = parseResult(invocation.stdout);
  assert.equal(result.valid, true);
  assert.equal(result.metadata_ready, false);
  assert.deepEqual(result.issue_codes, []);
  assert.ok(result.readiness_reasons.includes("DATASET_NOT_HISTORICAL"));
  assert.ok(result.readiness_reasons.includes("SOURCE_RIGHTS_NOT_APPROVED"));
  assert.ok(result.readiness_reasons.includes("HUMAN_REVIEWERS_BELOW_MINIMUM"));
  assert.ok(result.readiness_reasons.length > 0);

  const identifiers = [
    fixture.casebook_id,
    fixture.sources[0].source_id,
    fixture.cases[0].case_id,
    fixture.cases[0].reports[0].report_id,
    fixture.cases[0].reports[0].revision_id,
    fixture.cases[0].reports[0].content_hash,
    fixture.cases[0].reports[0].content_ref,
    fixture.cases[0].independent_reviews[0]?.reviewer_id,
    relativeFixturePath,
  ];
  for (const identifier of identifiers.filter((value): value is string => typeof value === "string")) {
    assert.equal(invocation.stdout.includes(identifier), false);
    assert.equal(invocation.stderr.includes(identifier), false);
  }
});

test("closed boolean states map only to the documented process statuses", () => {
  assert.deepEqual(
    [exitCodeFor(false, false), exitCodeFor(false, true), exitCodeFor(true, false), exitCodeFor(true, true)],
    [2, 2, 1, 0],
  );
});