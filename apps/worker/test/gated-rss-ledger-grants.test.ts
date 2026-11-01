import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// WJ-INT-02B ledger append-only pin: the triage attempt ledger must stay
// insert-only for the pipeline roles, and no application SQL outside
// migrations may UPDATE/DELETE its rows.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../../..');
const MIGRATIONS_DIR = path.join(REPO_ROOT, 'apps/db/migrations');

function readMigration(name: string): string {
  return readFileSync(path.join(MIGRATIONS_DIR, name), 'utf8');
}

function listFilesRecursive(dir: string, extension: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      out.push(...listFilesRecursive(full, extension));
    } else if (entry.isFile() && entry.name.endsWith(extension)) {
      out.push(full);
    }
  }
  return out;
}

describe('triage attempt ledger append-only grants', () => {
  it('pins SELECT+INSERT-only grants on news_triage_attempts across migrations', () => {
    const names = readdirSync(MIGRATIONS_DIR)
      .filter((name) => name.endsWith('.sql'))
      .sort();
    assert.ok(names.includes('041_triage_revision_lineage.sql'), 'attempt ledger migration present');
    const statements = names
      .map((name) => readMigration(name))
      .join('\n');
    const grantLines = statements
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => /^GRANT\b/i.test(line) && /news_triage_attempts/i.test(line));
    assert.ok(grantLines.length > 0, 'expected attempt-ledger GRANT statements');
    for (const line of grantLines) {
      assert.ok(
        /GRANT\s+SELECT\s*,\s*INSERT\s+ON/i.test(line),
        `attempt-ledger grant must be SELECT, INSERT only: ${line}`,
      );
      assert.ok(!/UPDATE|DELETE|TRUNCATE/i.test(line), `no mutation grants allowed: ${line}`);
    }
  });

  it('forbids UPDATE/DELETE of news_triage_attempts outside migrations', () => {
    const sources = [
      ...listFilesRecursive(path.join(REPO_ROOT, 'apps'), '.ts'),
      ...listFilesRecursive(path.join(REPO_ROOT, 'tools'), '.ts'),
    ].filter((file) => !file.endsWith('.test.ts') && !file.includes(`${path.sep}migrations${path.sep}`));
    const offenders: string[] = [];
    for (const file of sources) {
      const text = readFileSync(file, 'utf8');
      const lines = text.split('\n');
      for (const line of lines) {
        if (/news_triage_attempts/i.test(line) && /\b(UPDATE|DELETE\s+FROM|TRUNCATE)\b/i.test(line)) {
          offenders.push(`${path.relative(REPO_ROOT, file)}: ${line.trim()}`);
        }
      }
    }
    assert.deepEqual(offenders, []);
  });
});
