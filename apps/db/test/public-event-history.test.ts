import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import {
  createPublicEventHistoryRepository,
  PublicEventHistoryError,
  PUBLIC_EVENT_HISTORY_LIMITS,
} from '../src/public-event-history.js';
import type { SqlExecutor } from '../src/sql.js';
import { applyMigrations, readMigrations } from '../src/migrations.js';
import { createTestDatabase, type TestDatabase } from './harness.js';

// Every row is authored fictional data. The 'live' marker exercises a query
// boundary only; it is not live evidence, permission, or a factuality claim.
const TEST_TIME = '2026-09-26T10:00:00Z';

interface Fixture {
  readonly datasetKind: 'live' | 'historical' | 'synthetic';
  readonly prefix: string;
  readonly traceId: string;
  readonly sourceId: string;
  readonly revisionId: string;
  readonly candidateId: string;
  readonly contextId: string;
}

interface SeedVersion {
  readonly version: number;
  readonly status?: 'published' | 'withdrawn';
  readonly recordJson?: Record<string, unknown>;
}

interface HistoryQueryRow {
  readonly current_dataset_kind: unknown;
  readonly current_event_id: unknown;
  readonly current_version: unknown;
  readonly current_record_json: unknown;
  readonly dataset_kind: unknown;
  readonly event_id: unknown;
  readonly version: unknown;
  readonly record_json: unknown;
}

let testDatabase: TestDatabase;
let liveFixture: Fixture;
let historicalFixture: Fixture;
let syntheticFixture: Fixture;

describe('public event history repository', () => {
  before(async () => {
    testDatabase = await createTestDatabase();
    await applyMigrations(testDatabase.executor, await readMigrations(new URL('../migrations/', import.meta.url)));
    await testDatabase.executor.query(
      "INSERT INTO waspada.dataset_namespace_config (singleton, dataset_kind) VALUES (true, 'live')",
    );
    liveFixture = await seedFixture('live', 'history-live');
    historicalFixture = await seedFixture('historical', 'history-historical');
    syntheticFixture = await seedFixture('synthetic', 'history-synthetic');

    await seedEvent(testDatabase, liveFixture, 'event-paged', [
      { version: 1 }, { version: 2 }, { version: 3 }, { version: 4 },
    ]);
    await seedEvent(testDatabase, liveFixture, 'event-withdrawn', [
      { version: 1 }, { version: 2, status: 'withdrawn' },
    ]);
    await seedEvent(testDatabase, liveFixture, 'event-other', [{ version: 1 }]);

    const mismatchedOldRecord = eventRecord(liveFixture, 'event-unrelated-id', 1, 'published');
    await seedEvent(testDatabase, liveFixture, 'event-malformed-history', [
      { version: 1, recordJson: mismatchedOldRecord }, { version: 2 },
    ]);
    const extraPropertyCurrentRecord = {
      ...eventRecord(liveFixture, 'event-malformed-current', 1, 'published'),
      private_marker: 'fictional-only-malformed-envelope',
    };
    await seedEvent(testDatabase, liveFixture, 'event-malformed-current', [
      { version: 1, recordJson: extraPropertyCurrentRecord },
    ]);

    await seedEvent(testDatabase, historicalFixture, 'event-non-live', [{ version: 1 }]);
    await seedEvent(testDatabase, syntheticFixture, 'event-synthetic', [{ version: 1 }]);
  });

  after(async () => {
    await testDatabase?.close();
  });

  it('exposes only exact published live versions for events that remain current and public', async () => {
    const result = await testDatabase.executor.query<{
      dataset_kind: string;
      event_id: string;
      version: number;
      record_json: Record<string, unknown>;
    }>(
      `SELECT dataset_kind, event_id, version, record_json
       FROM waspada.public_event_history_versions
       ORDER BY event_id, version`,
    );

    assert.deepEqual(result.rows.map(({ event_id, version }) => [event_id, version]), [
      ['event-malformed-history', 2],
      ['event-other', 1],
      ['event-paged', 1],
      ['event-paged', 2],
      ['event-paged', 3],
      ['event-paged', 4],
    ]);
    assert.ok(result.rows.every(({ dataset_kind, record_json, event_id, version }) =>
      dataset_kind === 'live' && record_json.dataset_kind === 'live'
      && record_json.event_id === event_id && record_json.version === version));
    assert.ok(!result.rows.some(({ event_id }) => event_id === 'event-withdrawn'));
    assert.ok(!result.rows.some(({ event_id }) => event_id === 'event-non-live' || event_id === 'event-synthetic'));
    assert.ok(!result.rows.some(({ event_id }) => event_id === 'event-malformed-current'));
  });

  it('returns stable ascending pages with a validated version keyset and limit+1 probe', async () => {
    const calls: { statement: string; parameters: readonly unknown[] }[] = [];
    const repository = createPublicEventHistoryRepository(recordQueries(testDatabase.executor, calls));

    const first = await repository.read('event-paged', { limit: 2 });
    assert.equal(first.kind, 'found');
    if (first.kind !== 'found') return;
    assert.deepEqual(first.page.versions.map(({ eventVersion }) => eventVersion), [1, 2]);
    assert.equal(first.page.nextAfterVersion, 2);
    assert.equal(first.page.eventId, 'event-paged');
    assert.equal(first.page.versions[0]?.datasetKind, 'live');
    assert.deepEqual(first.page.versions[0]?.recordJson,
      eventRecord(liveFixture, 'event-paged', 1, 'published'));

    const second = await repository.read('event-paged', { limit: 2, afterVersion: first.page.nextAfterVersion });
    assert.equal(second.kind, 'found');
    if (second.kind !== 'found') return;
    assert.deepEqual(second.page.versions.map(({ eventVersion }) => eventVersion), [3, 4]);
    assert.equal(second.page.nextAfterVersion, null);

    assert.equal(calls.length, 2);
    assert.deepEqual(calls.map(({ parameters }) => parameters), [
      ['event-paged', 0, 3],
      ['event-paged', 2, 3],
    ]);
    assert.ok(calls.every(({ statement }) => /FROM waspada\.public_event_history_versions/iu.test(statement)));
    assert.ok(calls.every(({ statement }) => /event_id\s*=\s*\$1/iu.test(statement)));
    assert.ok(calls.every(({ statement }) => /version\s*>\s*\$2/iu.test(statement)));
    assert.ok(calls.every(({ statement }) => /ORDER BY history\.version ASC/iu.test(statement)));
    assert.ok(calls.every(({ statement }) => /LIMIT \$3/iu.test(statement)));
    assert.ok(calls.every(({ statement }) => !statement.includes('event-paged')));

    await assert.rejects(
      repository.read('event-paged', { afterVersion: 0 }),
      (error: unknown) => error instanceof PublicEventHistoryError && error.code === 'INVALID_PAGE',
    );
    assert.equal(calls.length, 2, 'invalid keysets are rejected before querying');
  });

  it('returns missing for unknown, withdrawn, and non-live events without exposing old versions', async () => {
    const repository = createPublicEventHistoryRepository(testDatabase.executor);
    assert.deepEqual(await repository.read('event-not-present'), { kind: 'missing' });
    assert.deepEqual(await repository.read('event-withdrawn'), { kind: 'missing' });
    assert.deepEqual(await repository.read('event-non-live'), { kind: 'missing' });
    assert.deepEqual(await repository.read('event-synthetic'), { kind: 'missing' });
  });

  it('cannot cross event IDs, datasets, or the event current-version boundary', async () => {
    const repository = createPublicEventHistoryRepository(testDatabase.executor);
    const onlyEvent = await repository.read('event-paged', { limit: 100, afterVersion: 2 });
    assert.equal(onlyEvent.kind, 'found');
    if (onlyEvent.kind !== 'found') return;
    assert.deepEqual(onlyEvent.page.versions.map(({ eventId, eventVersion, datasetKind }) =>
      [eventId, datasetKind, eventVersion]), [
      ['event-paged', 'live', 3],
      ['event-paged', 'live', 4],
    ]);
    const beyondCurrent = await repository.read('event-paged', { afterVersion: 4 });
    assert.deepEqual(beyondCurrent, {
      kind: 'found',
      page: { eventId: 'event-paged', versions: [], nextAfterVersion: null },
    });
    await assert.rejects(
      repository.read("event-paged' OR TRUE --"),
      (error: unknown) => error instanceof PublicEventHistoryError && error.code === 'INVALID_EVENT_ID',
    );

    await testDatabase.executor.query(
      "UPDATE waspada.dataset_namespace_config SET dataset_kind = 'historical' WHERE singleton = true",
    );
    try {
      assert.deepEqual(await repository.read('event-non-live'), { kind: 'missing' });
      const historyView = await testDatabase.executor.query<{ dataset_kind: string; event_id: string }>(
        `SELECT dataset_kind, event_id FROM waspada.public_event_history_versions
         WHERE event_id = $1`,
        ['event-non-live'],
      );
      assert.deepEqual(historyView.rows, [], 'historical current-public data is excluded by the live-only history view');
    } finally {
      await testDatabase.executor.query(
        "UPDATE waspada.dataset_namespace_config SET dataset_kind = 'live' WHERE singleton = true",
      );
    }
  });

  it('validates the exact current and history identities, closed schema envelope, order, and duplicates', async () => {
    const current = eventRecord(liveFixture, 'event-requested', 3, 'published');
    const row = (version: number, overrides: Partial<HistoryQueryRow> = {}): HistoryQueryRow => ({
      current_dataset_kind: 'live',
      current_event_id: 'event-requested',
      current_version: 3,
      current_record_json: current,
      dataset_kind: 'live',
      event_id: 'event-requested',
      version,
      record_json: eventRecord(liveFixture, 'event-requested', version, 'published'),
      ...overrides,
    });
    const marker = 'fictional-only-sensitive-marker';
    const cases: readonly { name: string; rows: readonly unknown[] }[] = [
      { name: 'wrong current event ID', rows: [row(1, { current_event_id: 'event-other-private' })] },
      { name: 'wrong history dataset', rows: [row(1, { dataset_kind: 'historical' })] },
      { name: 'wrong history event ID', rows: [row(1, { event_id: 'event-other-private' })] },
      { name: 'wrong record identity', rows: [row(1, { record_json: eventRecord(liveFixture, 'event-other-private', 1, 'published') })] },
      { name: 'extra top-level record key', rows: [row(1, { record_json: { ...eventRecord(liveFixture, 'event-requested', 1, 'published'), marker } })] },
      { name: 'duplicate version', rows: [row(1), row(1)] },
      { name: 'unstable version order', rows: [row(2), row(1)] },
      { name: 'version beyond current public version', rows: [row(4)] },
      { name: 'unexpected result column', rows: [{ ...row(1), private_value: marker }] },
      { name: 'malformed current envelope', rows: [row(1, { current_record_json: { ...current, private_value: marker } })] },
    ];
    for (const testCase of cases) {
      const executor = fixedRowsExecutor(testCase.rows);
      await assert.rejects(
        createPublicEventHistoryRepository(executor).read('event-requested'),
        (error: unknown) => error instanceof PublicEventHistoryError
          && error.code === 'RESULT_INVALID'
          && !error.message.includes(marker)
          && !error.message.includes('event-other-private'),
        testCase.name,
      );
    }
  });

  it('uses a security-barrier view and grants the reader no direct publication or source-table access', async () => {
    const view = await testDatabase.executor.query<{ reloptions: string[] | null }>(
      `SELECT relation.reloptions
       FROM pg_class AS relation
       WHERE relation.oid = 'waspada.public_event_history_versions'::regclass`,
    );
    assert.ok(view.rows[0]?.reloptions?.includes('security_barrier=true'));

    const permissions = await testDatabase.executor.query<{
      relation_name: string;
      can_select: boolean;
      can_insert: boolean;
      can_update: boolean;
      can_delete: boolean;
    }>(
      `SELECT relation.relname AS relation_name,
              has_table_privilege('waspada_public_reader', relation.oid, 'SELECT') AS can_select,
              has_table_privilege('waspada_public_reader', relation.oid, 'INSERT') AS can_insert,
              has_table_privilege('waspada_public_reader', relation.oid, 'UPDATE') AS can_update,
              has_table_privilege('waspada_public_reader', relation.oid, 'DELETE') AS can_delete
       FROM pg_class AS relation
       JOIN pg_namespace AS schema ON schema.oid = relation.relnamespace
       WHERE schema.nspname = 'waspada'
         AND relation.relname IN ('public_event_history_versions', 'event_versions',
           'publication_decisions', 'publication_claim_decisions', 'publication_decision_evidence',
           'event_claims', 'event_claim_evidence', 'event_claim_origins', 'event_claim_geometries',
           'impact_versions', 'impact_claim_support', 'event_impact_refs',
           'source_registry', 'report_revisions', 'evidence_references')
       ORDER BY relation.relname`,
    );
    const permissionByName = new Map(permissions.rows.map((row) => [row.relation_name, row]));
    assert.deepEqual(permissionByName.get('public_event_history_versions'), {
      relation_name: 'public_event_history_versions', can_select: true,
      can_insert: false, can_update: false, can_delete: false,
    });
    for (const relationName of [
      'event_versions', 'publication_decisions', 'publication_claim_decisions',
      'publication_decision_evidence', 'event_claims', 'event_claim_evidence',
      'event_claim_origins', 'event_claim_geometries', 'impact_versions', 'impact_claim_support',
      'event_impact_refs', 'source_registry', 'report_revisions', 'evidence_references',
    ]) {
      assert.deepEqual(permissionByName.get(relationName), {
        relation_name: relationName, can_select: false,
        can_insert: false, can_update: false, can_delete: false,
      });
    }

    await testDatabase.executor.execute('SET ROLE waspada_public_reader');
    try {
      const rows = await testDatabase.executor.query<{ event_id: string; version: number }>(
        `SELECT event_id, version FROM waspada.public_event_history_versions
         WHERE event_id = $1 ORDER BY version`,
        ['event-paged'],
      );
      assert.deepEqual(rows.rows.map(({ version }) => version), [1, 2, 3, 4]);
      await assert.rejects(
        testDatabase.executor.query('SELECT event_id FROM waspada.event_versions LIMIT 1'),
        /permission denied/iu,
      );
      await assert.rejects(
        testDatabase.executor.query('SELECT decision_id FROM waspada.publication_decisions LIMIT 1'),
        /permission denied/iu,
      );
      await assert.rejects(
        testDatabase.executor.query('SELECT permitted_text FROM waspada.report_revisions LIMIT 1'),
        /permission denied/iu,
      );
    } finally {
      await testDatabase.executor.execute('RESET ROLE');
    }
  });

  it('redacts database errors and rejects malformed query results with stable codes', async () => {
    const privateMarker = 'fictional-private-database-message';
    const failedExecutor: SqlExecutor = {
      async query<Row extends object>(): Promise<{ readonly rows: readonly Row[] }> {
        throw new Error('event-requested rejected: ' + privateMarker);
      },
      async execute() {},
    };
    await assert.rejects(
      createPublicEventHistoryRepository(failedExecutor).read('event-requested'),
      (error: unknown) => error instanceof PublicEventHistoryError
        && error.code === 'READ_FAILED'
        && !error.message.includes('event-requested')
        && !error.message.includes(privateMarker),
    );

    const malformedExecutor: SqlExecutor = {
      async query<Row extends object>() {
        return { rows: null as unknown as Row[] };
      },
      async execute() {},
    };
    await assert.rejects(
      createPublicEventHistoryRepository(malformedExecutor).read('event-requested'),
      (error: unknown) => error instanceof PublicEventHistoryError && error.code === 'RESULT_INVALID',
    );

    const invalidExecutor = fixedRowsExecutor([]);
    const repository = createPublicEventHistoryRepository(invalidExecutor);
    await assert.rejects(
      repository.read('event-requested', { limit: PUBLIC_EVENT_HISTORY_LIMITS.maxPageSize + 1 }),
      (error: unknown) => error instanceof PublicEventHistoryError && error.code === 'INVALID_PAGE',
    );
  });
});

async function seedFixture(datasetKind: Fixture['datasetKind'], prefix: string): Promise<Fixture> {
  const fixture: Fixture = {
    datasetKind,
    prefix,
    traceId: prefix + '-trace',
    sourceId: prefix + '-source',
    revisionId: prefix + '-revision',
    candidateId: prefix + '-candidate',
    contextId: prefix + '-context',
  };
  await testDatabase.executor.query(
    `INSERT INTO waspada.traces (trace_id, dataset_kind, started_at, outcome, metadata)
     VALUES ($1, $2, $3, 'succeeded', '{"fixture":"authored-fiction-only"}'::jsonb)`,
    [fixture.traceId, datasetKind, TEST_TIME],
  );
  await testDatabase.executor.query(
    `INSERT INTO waspada.source_registry
       (source_id, trace_id, registry_version, display_name, source_kind, remit,
        access_method, approved_hosts, access_restrictions, reuse_basis, registry_status,
        approval_status, health_status, auto_acquisition_enabled, auto_publication_policy)
     VALUES ($1, $2, 1, 'Fictional history test source', 'other', ARRAY['test fixture'],
       'manual_fixture', ARRAY[]::text[], ARRAY['fictional test only'], ARRAY['test only'],
       'active', 'pending', 'unknown', false, 'never')`,
    [fixture.sourceId, fixture.traceId],
  );
  await testDatabase.executor.query(
    `INSERT INTO waspada.report_revisions
       (dataset_kind, report_revision_id, trace_id, source_id, canonical_url,
        content_hash, permitted_text, permitted_text_hash, normalization_version,
        retrieved_at, revision_status, record_json)
     VALUES ($1, $2, $3, $4, $5, $6, 'Fictional text authored for a database test.',
       $7, 'history-test-v1', $8, 'unreviewed', '{"fixture":"authored-fiction-only"}'::jsonb)`,
    [
      datasetKind,
      fixture.revisionId,
      fixture.traceId,
      fixture.sourceId,
      'https://' + prefix + '.invalid/fixture',
      'b'.repeat(64),
      'a'.repeat(64),
      TEST_TIME,
    ],
  );
  await testDatabase.executor.query(
    `INSERT INTO waspada.extraction_results
       (dataset_kind, candidate_id, trace_id, report_revision_id, category, record_json)
     VALUES ($1, $2, $3, $4, 'group_specific_critical_notices',
       '{"fixture":"authored-fiction-only"}'::jsonb)`,
    [datasetKind, fixture.candidateId, fixture.traceId, fixture.revisionId],
  );
  await testDatabase.executor.query(
    `INSERT INTO waspada.grounding_contexts
       (dataset_kind, context_id, trace_id, candidate_id, retrieval_version,
        index_version, sufficient, record_json)
     VALUES ($1, $2, $3, $4, 'history-test-v1', 'history-test-index-v1', true,
       '{"fixture":"authored-fiction-only"}'::jsonb)`,
    [datasetKind, fixture.contextId, fixture.traceId, fixture.candidateId],
  );
  return fixture;
}

async function seedEvent(
  database: TestDatabase,
  fixture: Fixture,
  eventId: string,
  versions: readonly SeedVersion[],
): Promise<void> {
  for (const { version, status = 'published', recordJson } of versions) {
    const proposalId = fixture.prefix + '-proposal-' + eventId + '-v' + version;
    const decisionId = fixture.prefix + '-decision-' + eventId + '-v' + version;
    const record = recordJson ?? eventRecord(fixture, eventId, version, status);
    const publishedAt = status === 'published' ? TEST_TIME : null;
    const withdrawnAt = status === 'withdrawn' ? TEST_TIME : null;
    const withdrawalReason = status === 'withdrawn' ? 'duplicate' : null;
    await database.executor.transaction(async (transaction) => {
      await transaction.execute('SET CONSTRAINTS ALL DEFERRED');
      await transaction.query(
        `INSERT INTO waspada.event_proposals
           (dataset_kind, proposal_id, trace_id, candidate_id, context_id, event_id,
            base_event_version, proposed_at, record_json)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, '{"fixture":"authored-fiction-only"}'::jsonb)`,
        [
          fixture.datasetKind,
          proposalId,
          fixture.traceId,
          fixture.candidateId,
          fixture.contextId,
          version === 1 ? null : eventId,
          version === 1 ? null : version - 1,
          TEST_TIME,
        ],
      );
      await transaction.query(
        `INSERT INTO waspada.publication_decisions
           (dataset_kind, decision_id, trace_id, proposal_id, policy_version,
            event_id, event_version, decided_at, record_json)
         VALUES ($1, $2, $3, $4, 'history-test-policy-v1', $5, $6, $7,
           '{"fixture":"authored-fiction-only"}'::jsonb)`,
        [fixture.datasetKind, decisionId, fixture.traceId, proposalId, eventId, version, TEST_TIME],
      );
      await transaction.query(
        `INSERT INTO waspada.event_versions
           (dataset_kind, event_id, version, trace_id, supersedes_version, title, summary,
            category, lifecycle, publication_status, withdrawal_reason, publication_decision_id,
            published_at, withdrawn_at, record_json)
         VALUES ($1, $2, $3, $4, $5, 'Fictional history event',
            'Authored fictional event for a bounded database test.', 'group_specific_critical_notices',
            'unknown', $6, $7, $8, $9, $10, $11::jsonb)`,
        [
          fixture.datasetKind,
          eventId,
          version,
          fixture.traceId,
          version === 1 ? null : version - 1,
          status,
          withdrawalReason,
          decisionId,
          publishedAt,
          withdrawnAt,
          JSON.stringify(record),
        ],
      );
    });
  }
}

function eventRecord(
  fixture: Fixture,
  eventId: string,
  version: number,
  status: 'published' | 'withdrawn',
): Record<string, unknown> {
  const published = status === 'published';
  return {
    schema_version: '2.0',
    trace_id: fixture.traceId,
    record_type: 'Event',
    dataset_kind: fixture.datasetKind,
    event_id: eventId,
    version,
    supersedes_version: version === 1 ? null : version - 1,
    title: 'Fictional history event',
    summary: 'Authored fictional event for a bounded database test.',
    category: 'group_specific_critical_notices',
    tags: [],
    lifecycle: 'unknown',
    freshness: { status: 'current', evaluated_at: TEST_TIME, review_due_at: null, basis: 'unknown' },
    event_time: { start: null, end: null, precision: 'unknown' },
    validity: { valid_from: null, valid_until: null },
    scope: { place_ids: [], service_ids: [], institution_ids: [], audience_ids: [], geometry_ids: [] },
    claims: published ? [{ claim_id: 'claim-' + eventId + '-v' + version }] : [],
    impact_refs: [],
    publication_status: status,
    withdrawal_reason: published ? null : 'duplicate',
    publication_decision_id: fixture.traceId + '-decision-' + eventId + '-v' + version,
    published_at: published ? TEST_TIME : null,
    withdrawn_at: published ? null : TEST_TIME,
  };
}

function recordQueries(
  executor: SqlExecutor,
  calls: { statement: string; parameters: readonly unknown[] }[],
): SqlExecutor {
  return {
    async query<Row extends object>(statement: string, parameters?: readonly unknown[]) {
      calls.push({ statement, parameters: parameters ?? [] });
      return executor.query<Row>(statement, parameters);
    },
    execute(statement: string) {
      return executor.execute(statement);
    },
  };
}

function fixedRowsExecutor(rows: readonly unknown[]): SqlExecutor {
  return {
    async query<Row extends object>() {
      return { rows: rows as readonly Row[] };
    },
    async execute() {},
  };
}
