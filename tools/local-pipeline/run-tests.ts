import { readdir, readFile } from 'node:fs/promises';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * Isolate each top-level authored case: repeated PostgreSQL WASM instantiation
 * triggered a native V8 JIT-allocation crash in this WSL Node24 runtime.
 * A child crash/nonzero exit remains a failure, never an automatic retry.
 */
async function main(): Promise<void> {
const directory = new URL('./', import.meta.url);
const files = (await readdir(directory)).filter((file) => file.endsWith('.test.ts')).sort();
let active: ChildProcess | undefined;
let stopped = false;
const stop = () => { stopped = true; active?.kill('SIGTERM'); };
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
let passed = 0;
let total = 0;
try {
  if (files.length === 0) throw new Error('no_pipeline_tests');
  for (const file of files) {
    const path = fileURLToPath(new URL(file, directory));
    const source = await readFile(path, 'utf8');
    // These owned test files use one literal, single-line title per top-level test.
    // Refuse dynamic/unsupported declarations rather than silently skipping them.
    const declarations = source.match(/^\s*(?:test|it|describe)\b(?=\s*[.(\[])/gm) ?? [];
    const names = [...source.matchAll(/^test\((['"])([^\r\n]*?)\1,/gm)].map((match) => match[2]);
    if (names.length === 0 || names.length !== declarations.length || new Set(names).size !== names.length) {
      throw new Error('unsupported_pipeline_test_declaration');
    }
    for (const name of names) {
      total++;
      if (stopped) continue;
      const pattern = `^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`;
      console.log(`Pipeline case: ${file} — ${name}`);
      const ok = await new Promise<boolean>((resolve) => {
        const child = spawn(process.execPath, ['--import', 'tsx', '--test', '--test-name-pattern', pattern, path], { stdio: 'inherit' });
        active = child;
        child.once('error', () => resolve(false));
        child.once('close', (code, signal) => { if (active === child) active = undefined; resolve(code === 0 && signal === null); });
      });
      if (ok) passed++;
    }
  }
} catch {
  console.error('Pipeline test discovery or execution failed.');
  process.exitCode = 1;
} finally {
  process.removeListener('SIGINT', stop);
  process.removeListener('SIGTERM', stop);
}
console.log(`Pipeline cases: ${passed}/${total} passed.`);
if (passed !== total || total === 0 || stopped) process.exitCode = 1;
}
main().catch(() => { console.error('Pipeline test runner failed.'); process.exitCode = 1; });
