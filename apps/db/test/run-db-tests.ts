import { spawn, type ChildProcess } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

interface FileResult {
  readonly file: string;
  readonly passed: boolean;
  readonly reason?: string;
}

const testDirectory = dirname(fileURLToPath(import.meta.url));
const databaseDirectory = resolve(testDirectory, '..');
const parentSignals = new Set<NodeJS.Signals>();
let activeChild: ChildProcess | undefined;

function handleParentSignal(signal: NodeJS.Signals): void {
  parentSignals.add(signal);
  process.exitCode = 1;
  console.error(`DB test runner received ${signal}; cancelling the active child, and remaining files will not start.`);
  activeChild?.kill(signal);
}

process.on('SIGINT', () => handleParentSignal('SIGINT'));
process.on('SIGTERM', () => handleParentSignal('SIGTERM'));

async function runFile(file: string): Promise<FileResult> {
  const filePath = resolve(testDirectory, file);
  try {
    if (!statSync(filePath).isFile()) {
      return { file, passed: false, reason: 'discovered path is not a regular file' };
    }
  } catch (error) {
    return { file, passed: false, reason: `file is missing or unreadable: ${formatError(error)}` };
  }

  return await new Promise<FileResult>((resolveResult) => {
    let spawnError: Error | undefined;
    let child: ChildProcess;

    try {
      child = spawn(process.execPath, ['--import', 'tsx', '--test', filePath], {
        cwd: databaseDirectory,
        stdio: 'inherit',
      });
    } catch (error) {
      resolveResult({ file, passed: false, reason: `could not spawn child: ${formatError(error)}` });
      return;
    }

    activeChild = child;
    child.once('error', (error) => {
      spawnError = error;
    });
    child.once('close', (code, signal) => {
      if (activeChild === child) activeChild = undefined;

      const reasons: string[] = [];
      if (spawnError) reasons.push(`spawn error: ${formatError(spawnError)}`);
      if (signal) reasons.push(`interrupted by ${signal}`);
      else if (code !== 0) reasons.push(`exited with code ${code ?? 'unknown'}`);

      resolveResult({
        file,
        passed: reasons.length === 0,
        ...(reasons.length > 0 ? { reason: reasons.join('; ') } : {}),
      });
    });
  });
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function main(): Promise<void> {
  let files: string[];
  try {
    files = readdirSync(testDirectory)
      .filter((name) => name.endsWith('.test.ts'))
      .sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
  } catch (error) {
    console.error(`Could not discover DB test files: ${formatError(error)}`);
    process.exitCode = 1;
    return;
  }

  if (files.length === 0) {
    console.error(`No DB *.test.ts files found in ${testDirectory}`);
    process.exitCode = 1;
    return;
  }

  const results: FileResult[] = [];
  for (const file of files) {
    if (parentSignals.size > 0) {
      const reason = `not run after ${[...parentSignals].join(', ')}`;
      results.push({ file, passed: false, reason });
      console.error(`===== NOT RUN: ${file}: ${reason} =====`);
      continue;
    }

    console.log(`\n===== DB test: ${file} =====`);
    const result = await runFile(file);
    results.push(result);
    if (result.passed) console.log(`===== PASS: ${file} =====`);
    else console.error(`===== FAIL: ${file}: ${result.reason ?? 'unknown failure'} =====`);
  }

  const passedCount = results.filter(({ passed }) => passed).length;
  console.log(`\nDB test files: ${passedCount}/${results.length} passed.`);
  for (const result of results) {
    console.log(`${result.passed ? 'PASS' : 'FAIL'} ${result.file}${result.reason ? ` — ${result.reason}` : ''}`);
  }

  if (passedCount !== results.length || parentSignals.size > 0) process.exitCode = 1;
}

await main();
