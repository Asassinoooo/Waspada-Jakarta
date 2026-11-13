/**
 * F-03 layer import-boundary guard (TEST-GAP-02 / T7).
 *
 * Statically scans every Worker layer source for module specifiers that the
 * layer rules in CLAUDE.md forbid. TypeScript 7 no longer exposes a compiler
 * API to JavaScript, so this is a deliberately small text scanner rather than
 * an AST walk. It recognises statement-level `import`/`export ... from`,
 * side-effect `import "x"`, dynamic `import()` and `require()`, and ignores
 * lines that are only comments. Specifiers resolve relative to the importing
 * file; package and Node specifiers are external and never count as layers.
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const WORKER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const LAYER_NAMES = [
  "l1-data-knowledge",
  "l2-model-grounding",
  "l3-investigation",
  "l4-application-integration",
  "l5-evaluation-monitoring",
] as const;

/** Layers each importing layer must not reach. L1 may not investigate, publish, or evaluate. */
const FORBIDDEN_IMPORTS: Readonly<Record<string, readonly string[]>> = {
  "l1-data-knowledge": [
    "l2-model-grounding",
    "l3-investigation",
    "l4-application-integration",
    "l5-evaluation-monitoring",
  ],
  "l2-model-grounding": ["l3-investigation", "l4-application-integration"],
  "l3-investigation": ["l4-application-integration"],
};

/**
 * The one documented fixed L2 extraction adapter (ARCHITECTURE.md: "L1 pipeline
 * using L2 adapter"; DOMAIN_MODEL.md: "L1 pipeline using a fixed L2 adapter").
 * Its typed boundary lives here. L1 may depend on it only through `import type`.
 * The concrete adapter (`adapter.ts`) is not allowlisted, so it must be injected.
 */
const FIXED_L2_EXTRACTION_ADAPTER = "src/layers/l2-model-grounding/contracts.ts";

interface BoundaryException {
  readonly from: string;
  readonly to: string;
  /** When true, only `import type` / `export type` declarations are allowed. */
  readonly typeOnly: boolean;
  readonly reason: string;
}

const EXCEPTIONS: readonly BoundaryException[] = [
  {
    from: "src/layers/l1-data-knowledge/embedding-generation.ts",
    to: FIXED_L2_EXTRACTION_ADAPTER,
    typeOnly: true,
    reason: "fixed L2 model-capability adapter contract, type-only",
  },
  {
    from: "src/layers/l1-data-knowledge/synthetic-fixture-pipeline.ts",
    to: FIXED_L2_EXTRACTION_ADAPTER,
    typeOnly: true,
    reason: "fixed L2 model-capability adapter contract, type-only",
  },
  // TODO F-03-1: synthetic-fixture-runner.ts takes L5 telemetry values (event name,
  // max count, no-op sink) directly. Inject a telemetry port from the composition root.
  {
    from: "src/layers/l1-data-knowledge/synthetic-fixture-runner.ts",
    to: "src/layers/l5-evaluation-monitoring/telemetry.ts",
    typeOnly: false,
    reason: "L5 telemetry values, tracked as F-03-1",
  },
];

type ImportKind = "static" | "side-effect" | "dynamic" | "require";

interface RawSpecifier {
  readonly specifier: string;
  readonly typeOnly: boolean;
  readonly kind: ImportKind;
  readonly line: number;
}

interface Edge extends RawSpecifier {
  /** Worker-relative posix path of the importing file. */
  readonly from: string;
  /** Worker-relative posix path of the resolved relative target, with a `.ts` suffix. */
  readonly to: string;
}

const STATIC_IMPORT_OR_EXPORT = /^[ \t]*(import|export)\b([\w\s{},*$]+?)\bfrom\s*(['"])([^'"\n]+)\3/gm;
const SIDE_EFFECT_IMPORT = /^[ \t]*import\s*(['"])([^'"\n]+)\1/gm;
const DYNAMIC_IMPORT = /\bimport\s*\(\s*(['"`])([^'"`\n]+)\1\s*\)/g;
const REQUIRE_CALL = /\brequire\s*\(\s*(['"])([^'"\n]+)\1\s*\)/g;

function toPosix(value: string): string {
  return value.split(path.sep).join("/");
}

/** Extracts every module specifier in source text, in order of appearance. */
function scanSpecifiers(source: string): RawSpecifier[] {
  const lineOf = (index: number): number => source.slice(0, index).split("\n").length;
  const found: Array<RawSpecifier & { readonly index: number }> = [];

  for (const match of source.matchAll(STATIC_IMPORT_OR_EXPORT)) {
    const index = match.index ?? 0;
    found.push({
      specifier: match[4],
      // Only the declaration-level `import type` / `export type` is fully erased.
      typeOnly: /^\s*type\s/.test(match[2]),
      kind: "static",
      line: lineOf(index),
      index,
    });
  }
  for (const match of source.matchAll(SIDE_EFFECT_IMPORT)) {
    const index = match.index ?? 0;
    found.push({ specifier: match[2], typeOnly: false, kind: "side-effect", line: lineOf(index), index });
  }
  for (const match of source.matchAll(DYNAMIC_IMPORT)) {
    const index = match.index ?? 0;
    found.push({ specifier: match[2], typeOnly: false, kind: "dynamic", line: lineOf(index), index });
  }
  for (const match of source.matchAll(REQUIRE_CALL)) {
    const index = match.index ?? 0;
    found.push({ specifier: match[2], typeOnly: false, kind: "require", line: lineOf(index), index });
  }

  return found
    .sort((a, b) => a.index - b.index)
    .map(({ specifier, typeOnly, kind, line }) => ({ specifier, typeOnly, kind, line }));
}

/** Resolves a relative specifier to a worker-relative `.ts` path, or null for external specifiers. */
function resolveRelative(fromFile: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) return null;
  const target = path.resolve(WORKER_ROOT, path.dirname(fromFile), specifier);
  const tsPath = target.endsWith(".js") ? `${target.slice(0, -3)}.ts` : `${target}.ts`;
  return toPosix(path.relative(WORKER_ROOT, tsPath));
}

function layerOf(workerRelative: string): string | null {
  const parts = workerRelative.split("/");
  return parts[0] === "src" && parts[1] === "layers" && parts[2] ? parts[2] : null;
}

function listLayerSources(layer: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
        out.push(toPosix(path.relative(WORKER_ROOT, full)));
      }
    }
  };
  walk(path.join(WORKER_ROOT, "src", "layers", layer));
  return out.sort();
}

interface BoundaryViolation {
  readonly layer: string;
  readonly message: string;
}

interface BoundaryReport {
  readonly violations: readonly BoundaryViolation[];
  readonly usedExceptions: ReadonlySet<BoundaryException>;
  readonly scannedFiles: Readonly<Record<string, number>>;
}

function evaluateBoundaries(): BoundaryReport {
  const violations: BoundaryViolation[] = [];
  const usedExceptions = new Set<BoundaryException>();
  const scannedFiles: Record<string, number> = {};

  for (const layer of LAYER_NAMES) {
    const forbidden = FORBIDDEN_IMPORTS[layer] ?? [];
    const files = listLayerSources(layer);
    scannedFiles[layer] = files.length;

    for (const file of files) {
      const source = readFileSync(path.join(WORKER_ROOT, file), "utf8");
      for (const raw of scanSpecifiers(source)) {
        const edge: Edge = { ...raw, from: file, to: resolveRelative(file, raw.specifier) ?? "" };
        if (!edge.to) continue;

        const targetLayer = layerOf(edge.to);
        if (!targetLayer || targetLayer === layer || !forbidden.includes(targetLayer)) continue;

        const exception = EXCEPTIONS.find((item) => item.from === edge.from && item.to === edge.to);
        if (exception) {
          usedExceptions.add(exception);
          if (!exception.typeOnly || edge.typeOnly) continue;
          violations.push({
            layer,
            message: `${edge.from}:${edge.line} ${edge.kind} value import of ${edge.to}; the exception allows type-only imports (${exception.reason})`,
          });
          continue;
        }

        violations.push({
          layer,
          message: `${edge.from}:${edge.line} ${edge.typeOnly ? "type-only " : ""}${edge.kind} import of ${edge.to} (${targetLayer}); ${layer} must not import ${targetLayer}`,
        });
      }
    }
  }

  return { violations, usedExceptions, scannedFiles };
}

test("import scanner recognises every import form and ignores comment-only lines", () => {
  const sample = [
    `import { a } from "../l2-model-grounding/x.js";`,
    `import type { T } from "../l2-model-grounding/contracts.js";`,
    `import {`,
    `  b,`,
    `  type U,`,
    `} from "../l4-application-integration/y.js";`,
    `import "../l3-investigation/side.js";`,
    `export { c } from "../l5-evaluation-monitoring/z.js";`,
    `export type { V } from "../l3-investigation/v.js";`,
    `export * from "./local.js";`,
    `const m = await import("../l4-application-integration/dyn.js");`,
    `const r = require("../l2-model-grounding/cjs.js");`,
    `// import { c } from "../l4-application-integration/commented.js";`,
    ` * import { d } from "../l4-application-integration/jsdoc.js";`,
    `const url = "https://example.test/import from 'x'";`,
  ].join("\n");

  const found = scanSpecifiers(sample).map(({ specifier, typeOnly, kind }) => ({ specifier, typeOnly, kind }));
  assert.deepEqual(found, [
    { specifier: "../l2-model-grounding/x.js", typeOnly: false, kind: "static" },
    { specifier: "../l2-model-grounding/contracts.js", typeOnly: true, kind: "static" },
    { specifier: "../l4-application-integration/y.js", typeOnly: false, kind: "static" },
    { specifier: "../l3-investigation/side.js", typeOnly: false, kind: "side-effect" },
    { specifier: "../l5-evaluation-monitoring/z.js", typeOnly: false, kind: "static" },
    { specifier: "../l3-investigation/v.js", typeOnly: true, kind: "static" },
    { specifier: "./local.js", typeOnly: false, kind: "static" },
    { specifier: "../l4-application-integration/dyn.js", typeOnly: false, kind: "dynamic" },
    { specifier: "../l2-model-grounding/cjs.js", typeOnly: false, kind: "require" },
  ]);
});

test("L1 data-knowledge imports no L2-L5 module except the documented fixed L2 adapter (type-only) and TODO-tracked exceptions", () => {
  const report = evaluateBoundaries();
  assert.ok(report.scannedFiles["l1-data-knowledge"] > 0, "L1 layer scan found no source files");

  const l1Violations = report.violations.filter((violation) => violation.layer === "l1-data-knowledge");
  assert.deepEqual(l1Violations.map((violation) => violation.message), []);
});

test("L2 model-grounding does not import L3 or L4, and L3 investigation does not import L4", () => {
  const report = evaluateBoundaries();
  assert.ok(report.scannedFiles["l2-model-grounding"] > 0, "L2 layer scan found no source files");
  assert.ok(report.scannedFiles["l3-investigation"] > 0, "L3 layer scan found no source files");

  const generic = report.violations.filter((violation) => violation.layer !== "l1-data-knowledge");
  assert.deepEqual(generic.map((violation) => violation.message), []);
});

test("layer exceptions stay narrow: only the fixed L2 adapter, type-only, and every exception is still needed", () => {
  const report = evaluateBoundaries();

  for (const exception of EXCEPTIONS) {
    assert.ok(
      report.usedExceptions.has(exception),
      `exception is no longer needed and should be removed: ${exception.from} -> ${exception.to}`,
    );
  }

  for (const exception of EXCEPTIONS) {
    if (exception.to.startsWith("src/layers/l2-model-grounding/")) {
      assert.equal(exception.to, FIXED_L2_EXTRACTION_ADAPTER, "only the fixed L2 extraction adapter may be allowlisted");
      assert.equal(exception.typeOnly, true, "the fixed L2 adapter may be used only through type-only imports");
    }
  }
});
