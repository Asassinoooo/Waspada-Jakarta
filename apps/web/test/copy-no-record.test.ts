import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// COPY-02: the Bahasa Indonesia UI must not show the English word "record".
// This is a heuristic scan of apps/web/src/**/*.tsx, not a parser. It reads
// string/template literals and JSX text, and skips identifiers, class names,
// ids, keys and comments.

const SRC_DIR = fileURLToPath(new URL("../src/", import.meta.url));
const FORBIDDEN = /\brecord\b/i;
// Attributes whose value is an identifier rather than copy (aria-label stays checked).
const NON_COPY_ATTRIBUTE = /\b(?:className|class|id|key|htmlFor|name|type|role|href|src|fill|stroke|viewBox|d|data-[\w-]+)\s*=\s*\{?\s*$/;
const STRING_LITERAL = /"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g;
// JSX text runs from a tag's ">" or an expression's "}" up to the next "<" or "{".
// Code characters (= ( ) [ ] _ ") end a run, so type annotations, statements and
// attribute names are not read as copy.
const JSX_TEXT = /(?<=[\w"'\])}]>|\})([^<>{}()=\[\]_"]+)(?=[<{])/g;

function tsxFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return tsxFiles(path);
      return entry.isFile() && entry.name.endsWith(".tsx") ? [path] : [];
    })
    .sort();
}

function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");
}

function copyCandidates(source: string): string[] {
  const code = withoutComments(source);
  const candidates: string[] = [];
  for (const match of code.matchAll(STRING_LITERAL)) {
    const start = match.index ?? 0;
    if (NON_COPY_ATTRIBUTE.test(code.slice(Math.max(0, start - 40), start))) continue;
    const text = match[0].slice(1, -1).replace(/\$\{[^}]*\}/g, " ");
    // Single lower-case tokens (ids, keys, class-like names) are not copy.
    if (/\s/.test(text) || /^[A-Z]/.test(text)) candidates.push(text);
  }
  for (const match of code.matchAll(JSX_TEXT)) candidates.push(match[1] ?? "");
  return candidates;
}

function recordCopy(source: string, file: string): string[] {
  return copyCandidates(source)
    .filter((text) => FORBIDDEN.test(text))
    .map((text) => `${file}: ${text.trim()}`);
}

test("COPY-02 guard: the extractor catches record in JSX text and copy literals, not identifiers", () => {
  const sample = [
    "<p>{count} record cocok</p>",
    'const label = "Ada record pratinjau";',
    'const id = "record-map";',
    '<span className="record-row">ok</span>',
    '<ul aria-label="Record dari seluruh sumber" />',
  ].join("\n");
  const found = copyCandidates(sample).filter((text) => FORBIDDEN.test(text));
  assert.deepEqual(found.sort(), [" record cocok", "Ada record pratinjau", "Record dari seluruh sumber"].sort());
});

test("COPY-02: no user-visible record copy in apps/web/src tsx files", () => {
  const files = tsxFiles(SRC_DIR);
  assert.ok(files.length >= 20, `expected to scan the web src tree, found ${files.length} tsx files`);
  const findings = files.flatMap((file) => recordCopy(readFileSync(file, "utf8"), relative(SRC_DIR, file)));
  assert.deepEqual(findings, []);
});
