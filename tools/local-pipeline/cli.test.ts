import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseLocalOptions, runLocalCli } from './run-local-pipeline.js';

test('default CLI is disabled, explicit mock scheduling is finite', () => {
  assert.equal(parseLocalOptions([]).enabled, false);
  assert.deepEqual(parseLocalOptions(['--enable', '--watch', '--max-polls', '3', '--interval-ms', '1000', '--state', 'demo-1']),
    { enabled: true, watch: true, realAi: false, omitExtractionOutputLimits: false, status: false, state: 'demo-1', intervalMs: 1000, maxPolls: 3 });
});
test('extraction output-limit omission is explicit real mode policy only', () => {
  const once = parseLocalOptions(['--enable', '--once', '--real-ai', '--omit-extraction-output-limits']);
  assert.equal(once.realAi, true);
  assert.equal(once.omitExtractionOutputLimits, true);
  const state = 'real-12345678-1234-1234-1234-123456789012';
  assert.equal(parseLocalOptions(['--status', '--real-ai', '--omit-extraction-output-limits', '--state', state]).omitExtractionOutputLimits, true);
  for (const args of [['--omit-extraction-output-limits'], ['--enable', '--once', '--omit-extraction-output-limits'],
    ['--enable', '--once', '--real-ai', '--watch', '--omit-extraction-output-limits']]) {
    assert.throws(() => parseLocalOptions(args), /invalid_local_options/);
  }
});
test('real gateway requires an explicit one-cycle opt-in or read-only status of its isolated state', () => {
  assert.equal(parseLocalOptions(['--enable', '--once', '--real-ai']).realAi, true);
  const state = 'real-12345678-1234-1234-1234-123456789012';
  assert.equal(parseLocalOptions(['--enable', '--once', '--real-ai', '--state', state]).realAi, true);
  assert.equal(parseLocalOptions(['--status', '--real-ai', '--state', state]).status, true);
  for (const args of [['--real-ai'], ['--enable', '--real-ai'], ['--enable', '--real-ai', '--watch'],
    ['--enable', '--once', '--real-ai', '--state', 'existing'], ['--status', '--real-ai']]) {
    assert.throws(() => parseLocalOptions(args), /invalid_local_options/);
  }
});
test('real status resolves the same profile without sending provider HTTP', async () => {
  const priorCwd = process.cwd();
  const stateDir = mkdtempSync(join(tmpdir(), 'local-pipeline-status-'));
  const fetchBefore = globalThis.fetch;
  const envBefore = {
    url: process.env.NINEROUTER_URL,
    key: process.env.NINEROUTER_KEY,
    epoch: process.env.NINEROUTER_CURATION_EPOCH,
  };
  let requests = 0;
  const output: string[] = [];
  const logBefore = console.log;
  try {
    process.chdir(stateDir);
    process.env.NINEROUTER_URL = 'https://gateway.example/v1';
    process.env.NINEROUTER_KEY = 'test-key-status';
    process.env.NINEROUTER_CURATION_EPOCH = 'status-test';
    globalThis.fetch = (async () => { requests += 1; throw new Error('unexpected_provider_http'); }) as typeof fetch;
    console.log = (...values: unknown[]) => { output.push(values.join(' ')); };
    const state = 'real-12345678-1234-1234-1234-123456789012';
    await runLocalCli(['--status', '--real-ai', '--state', state]);
    assert.equal(requests, 0);
    assert.equal(JSON.parse(output[0] ?? '{}').status, 'local_state');
  } finally {
    console.log = logBefore;
    globalThis.fetch = fetchBefore;
    if (envBefore.url === undefined) delete process.env.NINEROUTER_URL;
    else process.env.NINEROUTER_URL = envBefore.url;
    if (envBefore.key === undefined) delete process.env.NINEROUTER_KEY;
    else process.env.NINEROUTER_KEY = envBefore.key;
    if (envBefore.epoch === undefined) delete process.env.NINEROUTER_CURATION_EPOCH;
    else process.env.NINEROUTER_CURATION_EPOCH = envBefore.epoch;
    process.chdir(priorCwd);
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('SIGTERM during asynchronous startup stops before scheduling and closes the local database', async () => {
  const priorCwd = process.cwd();
  const stateDir = mkdtempSync(join(tmpdir(), 'local-pipeline-stop-startup-'));
  const output: string[] = [];
  const logBefore = console.log;
  const priorListenerCount = process.listenerCount('SIGTERM');
  try {
    process.chdir(stateDir);
    console.log = (...values: unknown[]) => { output.push(values.join(' ')); };
    const startup = runLocalCli(['--enable', '--once', '--state', 'startup-stop']);
    assert.equal(process.emit('SIGTERM'), true);
    await startup;
    assert.equal(JSON.parse(output.at(-1) ?? '{}').status, 'stopped');
    assert.equal(process.listenerCount('SIGTERM'), priorListenerCount);
  } finally {
    console.log = logBefore;
    process.chdir(priorCwd);
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('unknown, duplicate, unbounded, conflicting and escaping arguments fail closed', () => {
  for (const args of [['--source', 'https://example.invalid'], ['--enable', '--enable'], ['--state', '../outside'],
    ['--state'], ['--max-polls', '10001'], ['--max-polls', '2'], ['--once', '--watch'], ['--watch', '--interval-ms', '0'], ['--status', '--enable']]) {
    assert.throws(() => parseLocalOptions(args), /invalid_local_options/);
  }
});
test('disabled and malformed CLI never echo credential-bearing environment', () => {
  const script = fileURLToPath(new URL('./run-local-pipeline.ts', import.meta.url));
  const sentinel = 'DO_NOT_EMIT_LOCAL_SECRET_7fe912';
  for (const args of [[], ['--source', sentinel]]) {
    const child = spawnSync(process.execPath, ['--import', 'tsx', script, ...args], {
      encoding: 'utf8', env: { ...process.env, NINEROUTER_URL: `https://${sentinel}.invalid`, NINEROUTER_KEY: sentinel },
    });
    const output = child.stdout + child.stderr;
    assert.equal(output.includes(sentinel), false);
    assert.equal(child.status, args.length ? 1 : 0);
    assert.equal(JSON.parse(child.stdout).status, args.length ? 'failed' : 'disabled');
  }
});
