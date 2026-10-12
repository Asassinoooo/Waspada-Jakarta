import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseLocalOptions } from './run-local-pipeline.js';

test('default CLI is disabled, explicit mock scheduling is finite', () => {
  assert.equal(parseLocalOptions([]).enabled, false);
  assert.deepEqual(parseLocalOptions(['--enable', '--watch', '--max-polls', '3', '--interval-ms', '1000', '--state', 'demo-1']),
    { enabled: true, watch: true, realAi: false, status: false, state: 'demo-1', intervalMs: 1000, maxPolls: 3 });
});
test('real gateway requires an explicit one-cycle opt-in and cannot drain existing state', () => {
  assert.equal(parseLocalOptions(['--enable', '--once', '--real-ai']).realAi, true);
  for (const args of [['--real-ai'], ['--enable', '--real-ai'], ['--enable', '--real-ai', '--watch'],
    ['--enable', '--once', '--real-ai', '--state', 'existing'], ['--status', '--real-ai']]) {
    assert.throws(() => parseLocalOptions(args), /invalid_local_options/);
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
