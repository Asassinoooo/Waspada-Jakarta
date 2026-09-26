import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { createPublicEventListRepository, PublicEventListError } from '../src/public-event-list.js';
import type { SqlExecutor } from '../src/sql.js';
import { applyMigrations, readMigrations } from '../src/migrations.js';
import { createTestDatabase, type TestDatabase } from './harness.js';

const FIRST = '2026-09-26T10:00:00.000000Z';
const FIRST_OFFSET = '2026-09-26T12:00:00+02:00';
const OLDER = '2026-09-26T09:00:00.000000Z';
const UPDATED = '2026-09-26T14:00:00.000000Z';
const WITHDRAWN = '2026-09-26T15:00:00.000000Z';

type DatasetKind = 'live' | 'synthetic';
interface Fixture {
  readonly datasetKind: DatasetKind;
  readonly prefix: string;
  readonly traceId: string;
  readonly sourceId: string;
  readonly revisionId: string;
  readonly candidateId: string;
  readonly contextId: string;
}
interface ListRow {
  readonly dataset_kind: unknown;
  readonly event_id: unknown;
  readonly version: unknown;
  readonly record_json: unknown;
  readonly first_record_json: unknown;
  readonly first_published_at: unknown;
}
let database: TestDatabase;
let live: Fixture;
let synthetic: Fixture;

describe('public event list candidate repository', () => {
  before(async () => {
    database = await createTestDatabase();
    await applyMigrations(database.executor, await readMigrations(new URL('../migrations/', import.meta.url)));
    await database.executor.query("INSERT INTO waspada.dataset_namespace_config (singleton, dataset_kind) VALUES (true, 'live')");
    live = await seedFixture('live', 'list-live');
    synthetic = await seedFixture('synthetic', 'list-synthetic');
    await seedEventVersion(live, 'event-tie-a', 1, 'published', FIRST);
    await seedEventVersion(live, 'event-tie-b', 1, 'published', FIRST_OFFSET);
    await seedEventVersion(live, 'event-older-c', 1, 'published', OLDER);
    await seedEventVersion(live, 'event-withdrawn', 1, 'published', WITHDRAWN);
    await seedEventVersion(live, 'event-withdrawn', 2, 'withdrawn', null);
    await seedEventVersion(synthetic, 'event-synthetic', 1, 'published', UPDATED);
  });

  after(async () => {
    await database?.close();
  });

  it('uses safe current/live views and continues by immutable version-1 time after a version update', async () => {
    const grants = await database.executor.query<{ current_view: boolean; history_view: boolean; base_table: boolean }>(
      `SELECT has_table_privilege('waspada_public_reader', 'waspada.public_event_versions', 'SELECT') AS current_view,
              has_table_privilege('waspada_public_reader', 'waspada.public_event_history_versions', 'SELECT') AS history_view,
              has_table_privilege('waspada_public_reader', 'waspada.event_versions', 'SELECT') AS base_table`,
    );
    assert.deepEqual(grants.rows[0], { current_view: true, history_view: true, base_table: false });

    await database.executor.execute('SET ROLE waspada_public_reader');
    try {
      const rolePage = await createPublicEventListRepository(database.executor).read({ limit: 1 });
      assert.equal(rolePage.candidates[0]?.eventId, 'event-tie-a');
      await assert.rejects(
        database.executor.query('SELECT event_id FROM waspada.event_versions LIMIT 1'),
        /permission denied/iu,
      );
    } finally {
      await database.executor.execute('RESET ROLE');
    }

    const calls: { statement: string; parameters: readonly unknown[] }[] = [];
    const repository = createPublicEventListRepository(recordQueries(database.executor, calls));
    const first = await repository.read({ limit: 1 });
    assert.deepEqual(first.candidates.map(({ eventId, eventVersion, firstPublishedAt }) =>
      [eventId, eventVersion, firstPublishedAt]), [['event-tie-a', 1, FIRST]]);
    assert.deepEqual(first.nextCursor, { firstPublishedAt: FIRST, eventId: 'event-tie-a' });

    await seedEventVersion(live, 'event-tie-b', 2, 'published', UPDATED);
    const second = await repository.read({ limit: 1, cursor: first.nextCursor });
    assert.equal(second.candidates[0]?.eventId, 'event-tie-b');
    assert.equal(second.candidates[0]?.eventVersion, 2);
    assert.equal(second.candidates[0]?.firstPublishedAt, FIRST);
    assert.equal((second.candidates[0]?.recordJson as Record<string, unknown>).published_at, UPDATED);
    assert.deepEqual(second.nextCursor, { firstPublishedAt: FIRST, eventId: 'event-tie-b' });

    const third = await repository.read({ limit: 1, cursor: second.nextCursor });
    assert.deepEqual(third.candidates.map(({ eventId }) => eventId), ['event-older-c']);
    assert.equal(third.nextCursor, null);
    assert.deepEqual(calls.map(({ parameters }) => parameters), [
      [2], [FIRST, 'event-tie-a', 2], [FIRST, 'event-tie-b', 2],
    ]);
    assert.ok(calls.every(({ statement }) =>
      /FROM waspada\.public_event_versions AS current/iu.test(statement)
      && /JOIN waspada\.public_event_history_versions AS initial/iu.test(statement)
      && /initial\.version = 1/iu.test(statement)
      && /ORDER BY first_published_at::timestamptz DESC, event_id COLLATE "C" ASC/iu.test(statement)
      && /LIMIT \$[13]/u.test(statement)
      && !/FROM waspada\.(?:event_versions|publication_decisions)/iu.test(statement)
      && !statement.includes('event-tie-a')));

    const visible = await repository.read();
    assert.deepEqual(visible.candidates.map(({ eventId }) => eventId),
      ['event-tie-a', 'event-tie-b', 'event-older-c'],
      'withdrawn and synthetic candidates stay out of live results');

    await database.executor.query("UPDATE waspada.dataset_namespace_config SET dataset_kind = 'synthetic' WHERE singleton = true");
    try {
      assert.deepEqual((await repository.read()).candidates, [],
        'the explicit live predicate excludes the configured synthetic namespace');
    } finally {
      await database.executor.query("UPDATE waspada.dataset_namespace_config SET dataset_kind = 'live' WHERE singleton = true");
    }
  });

  it('rejects invalid bounds and closed cursors before SQL, and redacts reader failures/results', async () => {
    let queryCount = 0;
    const countingExecutor: SqlExecutor = {
      async query<Row extends object>() {
        queryCount += 1;
        return { rows: [] as Row[] };
      },
      async execute() {},
    };
    const repository = createPublicEventListRepository(countingExecutor);
    for (const options of [
      { limit: 0 }, { limit: 101 }, { limit: Number.NaN }, { limit: 1.5 },
      { category: 'group_specific_critical_notices' },
      { cursor: { firstPublishedAt: FIRST, eventId: 'event-one', extra: true } },
      { cursor: { firstPublishedAt: '2026-02-30T10:00:00.000000Z', eventId: 'event-one' } },
      { cursor: { firstPublishedAt: FIRST, eventId: 'bad/id' } },
    ]) {
      await assert.rejects(repository.read(options), (error: unknown) =>
        error instanceof PublicEventListError && error.code === 'INVALID_PAGE');
    }
    assert.equal(queryCount, 0);

    const marker = 'fictional-private-query-detail';
    const failedExecutor: SqlExecutor = {
      async query<Row extends object>(): Promise<{ readonly rows: readonly Row[] }> {
        throw new Error(marker);
      },
      async execute() {},
    };
    await assert.rejects(createPublicEventListRepository(failedExecutor).read(), (error: unknown) =>
      error instanceof PublicEventListError && error.code === 'READ_FAILED' && !error.message.includes(marker));

    const valid = makeRow(live, 'event-fake', 1, FIRST);
    const malformedRows: readonly unknown[][] = [
      [{ ...valid, event_id: 'event-other' }],
      [{ ...valid, record_json: { ...(valid.record_json as Record<string, unknown>), private_marker: marker } }],
      [valid, { ...valid, version: 2 }],
      [{ ...valid, first_published_at: '2026-09-26T10:00:01.000000Z' }],
      [valid, makeRow(live, 'event-later', 1, UPDATED)],
    ];
    for (const rows of malformedRows) {
      await assert.rejects(
        createPublicEventListRepository(fixedRowsExecutor(rows)).read({ limit: 2 }),
        (error: unknown) => error instanceof PublicEventListError
          && error.code === 'RESULT_INVALID' && !error.message.includes(marker),
      );
    }
  });
});

async function seedFixture(datasetKind: DatasetKind, prefix: string): Promise<Fixture> {
  const fixture: Fixture = {
    datasetKind, prefix, traceId: prefix + '-trace', sourceId: prefix + '-source',
    revisionId: prefix + '-revision', candidateId: prefix + '-candidate', contextId: prefix + '-context',
  };
  await database.executor.query(
    `INSERT INTO waspada.traces (trace_id, dataset_kind, started_at, outcome, metadata)
     VALUES ($1, $2, $3, 'succeeded', '{"fixture":"authored-fiction-only"}'::jsonb)`,
    [fixture.traceId, datasetKind, FIRST],
  );
  await database.executor.query(
    `INSERT INTO waspada.source_registry
       (source_id, trace_id, registry_version, display_name, source_kind, remit,
        access_method, approved_hosts, access_restrictions, reuse_basis, registry_status,
        approval_status, health_status, auto_acquisition_enabled, auto_publication_policy)
     VALUES ($1, $2, 1, 'Fictional test source', 'other', ARRAY['test fixture'],
       'manual_fixture', ARRAY[]::text[], ARRAY['fictional only'], ARRAY['test only'],
       'active', 'pending', 'unknown', false, 'never')`,
    [fixture.sourceId, fixture.traceId],
  );
  await database.executor.query(
    `INSERT INTO waspada.report_revisions
       (dataset_kind, report_revision_id, trace_id, source_id, canonical_url,
        content_hash, permitted_text, permitted_text_hash, normalization_version,
        retrieved_at, revision_status, record_json)
     VALUES ($1, $2, $3, $4, $5, $6, 'Fictional test text.', $7,
       'list-test-v1', $8, 'unreviewed', '{"fixture":"authored-fiction-only"}'::jsonb)`,
    [datasetKind, fixture.revisionId, fixture.traceId, fixture.sourceId,
      'https://' + prefix + '.invalid/fixture', 'b'.repeat(64), 'a'.repeat(64), FIRST],
  );
  await database.executor.query(
    `INSERT INTO waspada.extraction_results
       (dataset_kind, candidate_id, trace_id, report_revision_id, category, record_json)
     VALUES ($1, $2, $3, $4, 'group_specific_critical_notices', '{"fixture":"authored-fiction-only"}'::jsonb)`,
    [datasetKind, fixture.candidateId, fixture.traceId, fixture.revisionId],
  );
  await database.executor.query(
    `INSERT INTO waspada.grounding_contexts
       (dataset_kind, context_id, trace_id, candidate_id, retrieval_version,
        index_version, sufficient, record_json)
     VALUES ($1, $2, $3, $4, 'list-test-v1', 'list-test-index-v1', true,
       '{"fixture":"authored-fiction-only"}'::jsonb)`,
    [datasetKind, fixture.contextId, fixture.traceId, fixture.candidateId],
  );
  return fixture;
}

async function seedEventVersion(
  fixture: Fixture, eventId: string, version: number,
  status: 'published' | 'withdrawn', publishedAt: string | null,
): Promise<void> {
  const withdrawnAt = status === 'withdrawn' ? WITHDRAWN : null;
  const withdrawalReason = status === 'withdrawn' ? 'duplicate' : null;
  const proposalId = fixture.prefix + '-proposal-' + eventId + '-v' + version;
  const decisionId = fixture.prefix + '-decision-' + eventId + '-v' + version;
  const record = eventRecord(fixture, eventId, version, status, publishedAt, withdrawnAt, withdrawalReason);
  await database.executor.transaction(async (transaction) => {
    await transaction.execute('SET CONSTRAINTS ALL DEFERRED');
    await transaction.query(
      `INSERT INTO waspada.event_proposals
         (dataset_kind, proposal_id, trace_id, candidate_id, context_id, event_id,
          base_event_version, proposed_at, record_json)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, '{"fixture":"authored-fiction-only"}'::jsonb)`,
      [fixture.datasetKind, proposalId, fixture.traceId, fixture.candidateId, fixture.contextId,
        version === 1 ? null : eventId, version === 1 ? null : version - 1, FIRST],
    );
    await transaction.query(
      `INSERT INTO waspada.publication_decisions
         (dataset_kind, decision_id, trace_id, proposal_id, policy_version,
          event_id, event_version, decided_at, record_json)
       VALUES ($1, $2, $3, $4, 'list-test-policy-v1', $5, $6, $7, '{"fixture":"authored-fiction-only"}'::jsonb)`,
      [fixture.datasetKind, decisionId, fixture.traceId, proposalId, eventId, version, FIRST],
    );
    await transaction.query(
      `INSERT INTO waspada.event_versions
         (dataset_kind, event_id, version, trace_id, supersedes_version, title, summary,
          category, lifecycle, publication_status, withdrawal_reason, publication_decision_id,
          published_at, withdrawn_at, record_json)
       VALUES ($1, $2, $3, $4, $5, 'Fictional event', 'Authored fictional test event.',
          'group_specific_critical_notices', 'unknown', $6, $7, $8, $9, $10, $11::jsonb)`,
      [fixture.datasetKind, eventId, version, fixture.traceId, version === 1 ? null : version - 1,
        status, withdrawalReason, decisionId, publishedAt, withdrawnAt, JSON.stringify(record)],
    );
  });
}

function eventRecord(
  fixture: Fixture, eventId: string, version: number, status: 'published' | 'withdrawn',
  publishedAt: string | null, withdrawnAt: string | null, withdrawalReason: string | null,
): Record<string, unknown> {
  const published = status === 'published';
  return {
    schema_version: '2.0', trace_id: fixture.traceId, record_type: 'Event',
    dataset_kind: fixture.datasetKind, event_id: eventId, version,
    supersedes_version: version === 1 ? null : version - 1,
    title: 'Fictional test event', summary: 'Authored fictional content for a database test.',
    category: 'group_specific_critical_notices', tags: [], lifecycle: 'unknown',
    freshness: { status: 'current', evaluated_at: FIRST, review_due_at: null, basis: 'unknown' },
    event_time: { start: null, end: null, precision: 'unknown' },
    validity: { valid_from: null, valid_until: null },
    scope: { place_ids: [], service_ids: [], institution_ids: [], audience_ids: [], geometry_ids: [] },
    claims: published ? [{ claim_id: 'claim-' + eventId + '-v' + version }] : [],
    impact_refs: [], publication_status: status, withdrawal_reason: withdrawalReason,
    publication_decision_id: fixture.prefix + '-decision-' + eventId + '-v' + version,
    published_at: publishedAt, withdrawn_at: withdrawnAt,
  };
}

function makeRow(fixture: Fixture, eventId: string, version: number, timestamp: string): ListRow {
  const first = eventRecord(fixture, eventId, 1, 'published', timestamp, null, null);
  const current = version === 1
    ? first
    : eventRecord(fixture, eventId, version, 'published', UPDATED, null, null);
  const normalized = timestamp === FIRST_OFFSET ? FIRST
    : timestamp.replace(/Z$/u, '.000000Z').replace(/\.000000\.000000Z$/u, '.000000Z');
  return {
    dataset_kind: 'live', event_id: eventId, version, record_json: current,
    first_record_json: first, first_published_at: normalized,
  };
}

function recordQueries(
  executor: SqlExecutor, calls: { statement: string; parameters: readonly unknown[] }[],
): SqlExecutor {
  return {
    async query<Row extends object>(statement: string, parameters?: readonly unknown[]) {
      calls.push({ statement, parameters: parameters ?? [] });
      return executor.query<Row>(statement, parameters);
    },
    execute(statement: string) { return executor.execute(statement); },
  };
}

function fixedRowsExecutor(rows: readonly unknown[]): SqlExecutor {
  return {
    async query<Row extends object>() { return { rows: rows as readonly Row[] }; },
    async execute() {},
  };
}
