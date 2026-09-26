import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { applyMigrations, readMigrations } from '../src/migrations.js';
import {
  createPublicEventSnapshotRepository,
  PublicEventSnapshotError,
  PUBLIC_EVENT_SNAPSHOT_LIMITS,
} from '../src/public-event-snapshot.js';
import type { SqlExecutor } from '../src/sql.js';
import { createTestDatabase, type TestDatabase } from './harness.js';

// Every row below is authored fictional test data. Rows marked dataset_kind='live'
// only exercise the live-only query predicate; they are not live source records,
// human review, factuality evidence, publication permission, or a source-rights grant.
const TEST_TIME = '2026-09-26T10:00:00Z';
const TEST_HASH = 'a'.repeat(64);

interface DatasetFixture {
  readonly datasetKind: 'live' | 'synthetic';
  readonly prefix: string;
  readonly traceId: string;
  readonly sourceId: string;
  readonly revisionId: string;
  readonly candidateId: string;
  readonly contextId: string;
}

interface ImpactFixture {
  readonly impactId: string;
  readonly impactVersion: number;
}

let testDatabase: TestDatabase;
let liveFixture: DatasetFixture;
let syntheticFixture: DatasetFixture;

describe('public event snapshot repository', () => {
  before(async () => {
    testDatabase = await createTestDatabase();
    await applyMigrations(testDatabase.executor, await readMigrations(new URL('../migrations/', import.meta.url)));
    await testDatabase.executor.query(
      `INSERT INTO waspada.dataset_namespace_config (singleton, dataset_kind)
       VALUES (true, 'live')`,
    );
    liveFixture = await seedDataset(testDatabase, 'live', 'fixture-live');
    syntheticFixture = await seedDataset(testDatabase, 'synthetic', 'fixture-synthetic');

    await seedPublishedEvent(testDatabase, liveFixture, 'event-current', 1, [
      { impactId: 'impact-shared', impactVersion: 1 },
    ]);
    await seedPublishedEvent(testDatabase, liveFixture, 'event-current', 2, [
      { impactId: 'impact-z', impactVersion: 1 },
      { impactId: 'impact-shared', impactVersion: 2 },
      { impactId: 'impact-a', impactVersion: 1 },
    ]);
    await seedPublishedEvent(testDatabase, liveFixture, 'event-withdrawn', 1, [
      { impactId: 'impact-withdrawn-old', impactVersion: 1 },
    ]);
    await seedWithdrawnEvent(testDatabase, liveFixture, 'event-withdrawn', 2);
    await seedPublishedEvent(
      testDatabase,
      liveFixture,
      'event-many',
      1,
      Array.from({ length: PUBLIC_EVENT_SNAPSHOT_LIMITS.impacts + 1 }, (_, index) => ({
        impactId: 'impact-many-' + String(index).padStart(3, '0'),
        impactVersion: 1,
      })),
    );
    await seedPublishedEvent(testDatabase, syntheticFixture, 'event-synthetic', 1, []);
  });

  after(async () => {
    await testDatabase?.close();
  });

  it('reads one current live event and impacts linked to its exact current version', async () => {
    const calls: { statement: string; parameters: readonly unknown[] }[] = [];
    const repository = createPublicEventSnapshotRepository(recordQueries(testDatabase.executor, calls));
    const result = await repository.read('event-current');

    assert.equal(result.kind, 'found');
    if (result.kind !== 'found') return;
    assert.equal(result.snapshot.datasetKind, 'live');
    assert.equal(result.snapshot.eventId, 'event-current');
    assert.equal(result.snapshot.eventVersion, 2);
    assert.deepEqual(result.snapshot.recordJson,
      eventRecord(liveFixture, 'event-current', 2, 'published', [
        { impactId: 'impact-z', impactVersion: 1 },
        { impactId: 'impact-shared', impactVersion: 2 },
        { impactId: 'impact-a', impactVersion: 1 },
      ]));
    assert.deepEqual(result.snapshot.impacts.map(({ impactId, impactVersion }) => [impactId, impactVersion]), [
      ['impact-a', 1],
      ['impact-shared', 2],
      ['impact-z', 1],
    ]);
    assert.ok(result.snapshot.impacts.every((impact) =>
      impact.eventId === 'event-current' && impact.eventVersion === 2));
    assert.deepEqual(result.snapshot.impacts[0]?.recordJson,
      impactRecord('event-current', 2, 'impact-a', 1));

    assert.equal(calls.length, 2);
    assert.match(calls[0]?.statement ?? '', /FROM waspada\.public_event_versions/iu);
    assert.match(calls[1]?.statement ?? '', /FROM waspada\.public_event_impacts/iu);
    assert.ok(calls.every(({ statement }) =>
      !/FROM waspada\.(?:event_versions|impact_versions|event_impact_refs)\b/iu.test(statement)));
    assert.deepEqual(calls[0]?.parameters, ['event-current']);
    assert.deepEqual(calls[1]?.parameters, ['event-current', 2, 101]);
    assert.match(calls[0]?.statement ?? '', /event_id\s*=\s*\$1/iu);
    assert.match(calls[1]?.statement ?? '', /event_id\s*=\s*\$1/u);
    assert.match(calls[1]?.statement ?? '', /event_version\s*=\s*\$2/u);
    assert.match(calls[1]?.statement ?? '', /LIMIT\s+\$3/u);

    await assert.rejects(
      repository.read("event-current' OR TRUE --"),
      (error: unknown) => error instanceof PublicEventSnapshotError && error.code === 'INVALID_EVENT_ID',
    );
    assert.equal(calls.length, 2, 'invalid identifiers are rejected before querying');
  });

  it('returns missing when the latest version is withdrawn or no live row exists', async () => {
    const repository = createPublicEventSnapshotRepository(testDatabase.executor);
    assert.deepEqual(await repository.read('event-withdrawn'), { kind: 'missing' });
    assert.deepEqual(await repository.read('event-not-present'), { kind: 'missing' });
  });

  it('requires live data when the configured view exposes a synthetic namespace', async () => {
    const repository = createPublicEventSnapshotRepository(testDatabase.executor);
    await testDatabase.executor.query(
      `UPDATE waspada.dataset_namespace_config
       SET dataset_kind = 'synthetic'
       WHERE singleton = true`,
    );
    try {
      assert.deepEqual(await repository.read('event-synthetic'), { kind: 'missing' });
    } finally {
      await testDatabase.executor.query(
        `UPDATE waspada.dataset_namespace_config
         SET dataset_kind = 'live'
         WHERE singleton = true`,
      );
    }
  });

  it('fails with a bounded error when more than 100 impacts match', async () => {
    const repository = createPublicEventSnapshotRepository(testDatabase.executor);
    await assert.rejects(
      repository.read('event-many'),
      (error: unknown) => error instanceof PublicEventSnapshotError
        && error.code === 'IMPACT_LIMIT_EXCEEDED'
        && !error.message.includes('event-many')
        && !error.message.includes('fixture-live'),
    );
  });

  it('uses the public reader role and cannot read base event or impact tables', async () => {
    const calls: { statement: string; parameters: readonly unknown[] }[] = [];
    const repository = createPublicEventSnapshotRepository(recordQueries(testDatabase.executor, calls));
    await testDatabase.executor.execute('SET ROLE waspada_public_reader');
    try {
      const result = await repository.read('event-current');
      assert.equal(result.kind, 'found');
      assert.equal(calls.length, 2);
      await assert.rejects(
        testDatabase.executor.query('SELECT event_id FROM waspada.event_versions LIMIT 1'),
        /permission denied/iu,
      );
      await assert.rejects(
        testDatabase.executor.query('SELECT impact_id FROM waspada.impact_versions LIMIT 1'),
        /permission denied/iu,
      );
    } finally {
      await testDatabase.executor.execute('RESET ROLE');
    }
  });

  it('rejects malformed rows and read failures without exposing values', async () => {
    const marker = 'fixture-only-private-payload-marker';
    const wrongEventExecutor: SqlExecutor = {
      async query<Row extends object>() {
        return { rows: [{
          dataset_kind: 'live',
          event_id: 'fixture-wrong-event-id',
          version: 1,
          record_json: { marker },
        } as Row] };
      },
      async execute() {},
    };
    await assert.rejects(
      createPublicEventSnapshotRepository(wrongEventExecutor).read('event-requested'),
      (error: unknown) => error instanceof PublicEventSnapshotError
        && error.code === 'RESULT_INVALID'
        && !error.message.includes('fixture-wrong-event-id')
        && !error.message.includes(marker),
    );

    let queryCount = 0;
    const wrongImpactExecutor: SqlExecutor = {
      async query<Row extends object>() {
        queryCount += 1;
        const rows = queryCount === 1
          ? [{
            dataset_kind: 'live',
            event_id: 'event-requested',
            version: 3,
            record_json: { marker },
          }]
          : [{
            dataset_kind: 'live',
            event_id: 'event-requested',
            event_version: 2,
            impact_id: 'impact-private-id',
            impact_version: 1,
            record_json: { marker },
          }];
        return { rows: rows as Row[] };
      },
      async execute() {},
    };
    await assert.rejects(
      createPublicEventSnapshotRepository(wrongImpactExecutor).read('event-requested'),
      (error: unknown) => error instanceof PublicEventSnapshotError
        && error.code === 'RESULT_INVALID'
        && !error.message.includes('impact-private-id')
        && !error.message.includes(marker),
    );

    const failedExecutor: SqlExecutor = {
      async query<Row extends object>(): Promise<{ readonly rows: readonly Row[] }> {
        throw new Error('database rejected event-requested: ' + marker);
      },
      async execute() {},
    };
    await assert.rejects(
      createPublicEventSnapshotRepository(failedExecutor).read('event-requested'),
      (error: unknown) => error instanceof PublicEventSnapshotError
        && error.code === 'READ_FAILED'
        && !error.message.includes('event-requested')
        && !error.message.includes(marker),
    );
  });
});

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

async function seedDataset(
  database: TestDatabase,
  datasetKind: DatasetFixture['datasetKind'],
  prefix: string,
): Promise<DatasetFixture> {
  const fixture: DatasetFixture = {
    datasetKind,
    prefix,
    traceId: prefix + '-trace',
    sourceId: prefix + '-source',
    revisionId: prefix + '-revision',
    candidateId: prefix + '-candidate',
    contextId: prefix + '-context',
  };
  await database.executor.query(
    `INSERT INTO waspada.traces (trace_id, dataset_kind, started_at, outcome, metadata)
     VALUES ($1, $2, $3, 'succeeded', '{"fixture":"authored-fiction-only"}'::jsonb)`,
    [fixture.traceId, datasetKind, TEST_TIME],
  );
  await database.executor.query(
    `INSERT INTO waspada.source_registry
       (source_id, trace_id, registry_version, display_name, source_kind, remit,
        access_method, approved_hosts, access_restrictions, reuse_basis, registry_status,
        approval_status, health_status, auto_acquisition_enabled, auto_publication_policy)
     VALUES ($1, $2, 1, 'Fictional snapshot test source', 'other', ARRAY['test fixture'],
       'manual_fixture', ARRAY[]::text[], ARRAY['fictional test data only'], ARRAY['test only'],
       'active', 'pending', 'unknown', false, 'never')`,
    [fixture.sourceId, fixture.traceId],
  );
  await database.executor.query(
    `INSERT INTO waspada.report_revisions
       (dataset_kind, report_revision_id, trace_id, source_id, canonical_url,
        content_hash, permitted_text, permitted_text_hash, normalization_version,
        retrieved_at, revision_status, record_json)
     VALUES ($1, $2, $3, $4, $5, $6, 'Fictional text authored for a database test.',
        $7, 'normalization-fixture-v1', $8, 'unreviewed',
        '{"fixture":"authored-fiction-only"}'::jsonb)`,
    [
      datasetKind,
      fixture.revisionId,
      fixture.traceId,
      fixture.sourceId,
      'https://' + prefix + '.invalid/fixture',
      'b'.repeat(64),
      TEST_HASH,
      TEST_TIME,
    ],
  );
  await database.executor.query(
    `INSERT INTO waspada.extraction_results
       (dataset_kind, candidate_id, trace_id, report_revision_id, category, record_json)
     VALUES ($1, $2, $3, $4, 'group_specific_critical_notices',
       '{"fixture":"authored-fiction-only"}'::jsonb)`,
    [datasetKind, fixture.candidateId, fixture.traceId, fixture.revisionId],
  );
  await database.executor.query(
    `INSERT INTO waspada.grounding_contexts
       (dataset_kind, context_id, trace_id, candidate_id, retrieval_version,
        index_version, sufficient, record_json)
     VALUES ($1, $2, $3, $4, 'snapshot-test-v1', 'snapshot-index-v1', true,
       '{"fixture":"authored-fiction-only"}'::jsonb)`,
    [datasetKind, fixture.contextId, fixture.traceId, fixture.candidateId],
  );
  return fixture;
}

async function seedPublishedEvent(
  database: TestDatabase,
  fixture: DatasetFixture,
  eventId: string,
  version: number,
  impacts: readonly ImpactFixture[],
): Promise<void> {
  await seedEventVersion(database, fixture, eventId, version, 'published', impacts);
}

async function seedWithdrawnEvent(
  database: TestDatabase,
  fixture: DatasetFixture,
  eventId: string,
  version: number,
): Promise<void> {
  await seedEventVersion(database, fixture, eventId, version, 'withdrawn', []);
}

async function seedEventVersion(
  database: TestDatabase,
  fixture: DatasetFixture,
  eventId: string,
  version: number,
  status: 'published' | 'withdrawn',
  impacts: readonly ImpactFixture[],
): Promise<void> {
  const proposalId = fixture.prefix + '-proposal-' + eventId + '-v' + version;
  const decisionId = fixture.prefix + '-decision-' + eventId + '-v' + version;
  const record = eventRecord(fixture, eventId, version, status, impacts);
  const publishedAt = status === 'published' ? TEST_TIME : null;
  const withdrawnAt = status === 'withdrawn' ? TEST_TIME : null;
  const withdrawalReason = status === 'withdrawn' ? 'duplicate' : null;

  await database.executor.transaction(async (transaction) => {
    await transaction.execute('SET CONSTRAINTS ALL DEFERRED');
    await transaction.query(
      `INSERT INTO waspada.event_proposals
         (dataset_kind, proposal_id, trace_id, candidate_id, context_id, event_id,
          base_event_version, proposed_at, record_json)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8,
          '{"fixture":"authored-fiction-only"}'::jsonb)`,
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
       VALUES ($1, $2, $3, $4, 'snapshot-test-policy-v1', $5, $6, $7,
          '{"fixture":"authored-fiction-only"}'::jsonb)`,
      [fixture.datasetKind, decisionId, fixture.traceId, proposalId, eventId, version, TEST_TIME],
    );
    await transaction.query(
      `INSERT INTO waspada.event_versions
         (dataset_kind, event_id, version, trace_id, supersedes_version, title, summary,
          category, lifecycle, publication_status, withdrawal_reason, publication_decision_id,
          published_at, withdrawn_at, record_json)
       VALUES ($1, $2, $3, $4, $5, 'Fictional snapshot event',
          'Authored fictional event for a database test.', 'group_specific_critical_notices',
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

    for (const impact of impacts) {
      await transaction.query(
        `INSERT INTO waspada.impact_versions
           (dataset_kind, impact_id, version, trace_id, event_id, event_version,
            impact_type, lifecycle, published_at, record_json)
         VALUES ($1, $2, $3, $4, $5, $6, 'other', 'unknown', $7, $8::jsonb)`,
        [
          fixture.datasetKind,
          impact.impactId,
          impact.impactVersion,
          fixture.traceId,
          eventId,
          version,
          TEST_TIME,
          JSON.stringify(impactRecord(eventId, version, impact.impactId, impact.impactVersion)),
        ],
      );
      await transaction.query(
        `INSERT INTO waspada.event_impact_refs
           (dataset_kind, event_id, event_version, impact_id, impact_version)
         VALUES ($1, $2, $3, $4, $5)`,
        [fixture.datasetKind, eventId, version, impact.impactId, impact.impactVersion],
      );
    }
  });
}

function eventRecord(
  fixture: DatasetFixture,
  eventId: string,
  version: number,
  status: 'published' | 'withdrawn',
  impacts: readonly ImpactFixture[],
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
    title: 'Fictional snapshot event',
    summary: 'Authored fictional event for a database test.',
    category: 'group_specific_critical_notices',
    lifecycle: 'unknown',
    claims: published ? [{ claim_id: 'fictional-claim' }] : [],
    impact_refs: published ? impacts.map(({ impactId, impactVersion }) => ({
      impact_id: impactId,
      version: impactVersion,
    })) : [],
    publication_status: status,
    withdrawal_reason: published ? null : 'duplicate',
    published_at: published ? TEST_TIME : null,
    withdrawn_at: published ? null : TEST_TIME,
    fixture_marker: 'untrusted-internal-json-fixture',
  };
}

function impactRecord(
  eventId: string,
  eventVersion: number,
  impactId: string,
  impactVersion: number,
): Record<string, unknown> {
  return {
    schema_version: '2.0',
    trace_id: 'fixture-live-trace',
    record_type: 'Impact',
    dataset_kind: 'live',
    event_id: eventId,
    event_version: eventVersion,
    impact_id: impactId,
    version: impactVersion,
    impact_type: 'other',
    lifecycle: 'unknown',
    fixture_marker: 'untrusted-impact-json-fixture',
  };
}
