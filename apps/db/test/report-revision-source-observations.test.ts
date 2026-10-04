import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import {
  createSqlReportRevisionSourceObservationRepository,
  ReportRevisionSourceObservationError,
  type NewReportRevisionSourceObservation,
} from '../src/report-revision-source-observations.js';
import { applyMigrations, readMigrations } from '../src/migrations.js';
import { createTestDatabase, type TestDatabase } from './harness.js';

const L1_ROLE = 'waspada_l1_pipeline';
const OBSERVED_AT = '2026-10-01T01:02:03.123456Z';
const RETRIEVED_AT = '2026-10-02T04:05:06.654321+07:00';

let database: TestDatabase;
let repository: ReturnType<typeof createSqlReportRevisionSourceObservationRepository>;
let beforeSideEffects: SideEffectSnapshot;

describe('LIFE-01 source revision observations', () => {
  before(async () => {
    database = await createTestDatabase();
    const migrations = await readMigrations(new URL('../migrations/', import.meta.url));
    await applyMigrations(database.executor, migrations);
    repository = createSqlReportRevisionSourceObservationRepository(database.executor);
    await seedFixtures();
    beforeSideEffects = await readSideEffects();
  });

  after(async () => {
    await database?.close();
  });

  it('stores all four explicit publisher states with three separate times and exact lineage', async () => {
    const inputs = [
      observation('obs-current', 'current', 'revision-current-notice'),
      observation('obs-superseded', 'superseded', 'revision-superseded-notice', {
        replacementReportRevisionId: 'revision-replacement',
      }),
      observation('obs-retracted', 'retracted', 'revision-retracted-notice'),
      observation('obs-withdrawn', 'withdrawn', 'revision-withdrawn-notice'),
    ];
    const records: Awaited<ReturnType<typeof repository.create>>[] = [];
    for (const input of inputs) records.push(await repository.create(input));

    assert.deepEqual(records.map(({ assertedState }) => assertedState).sort(), [
      'current', 'retracted', 'superseded', 'withdrawn',
    ]);
    assert.equal(records[1]?.replacementReportRevisionId, 'revision-replacement');
    for (const record of records) {
      assert.equal(record.sourceId, 'source-observation-a');
      assert.equal(record.targetReportRevisionId, 'revision-target');
      assert.equal(record.datasetKind, 'synthetic');
    }

    const storedStates = await database.executor.query<{ asserted_state: string }>(
      `SELECT asserted_state
       FROM waspada.report_revision_source_observations
       WHERE dataset_kind = 'synthetic' AND target_report_revision_id = 'revision-target'
       ORDER BY asserted_state`,
    );
    assert.deepEqual(storedStates.rows.map(({ asserted_state }) => asserted_state), [
      'current', 'retracted', 'superseded', 'withdrawn',
    ], 'contradictory assertions remain separate rows without a resolved winner');

    const distinctTimes = await database.executor.query<{
      observed_differs_from_retrieved: boolean;
      recorded_differs_from_observed: boolean;
      recorded_differs_from_retrieved: boolean;
    }>(
      `SELECT publisher_observed_at IS DISTINCT FROM retrieved_at AS observed_differs_from_retrieved,
              recorded_at IS DISTINCT FROM publisher_observed_at AS recorded_differs_from_observed,
              recorded_at IS DISTINCT FROM retrieved_at AS recorded_differs_from_retrieved
       FROM waspada.report_revision_source_observations
       WHERE dataset_kind = 'synthetic' AND observation_id = 'obs-current'`,
    );
    assert.deepEqual(distinctTimes.rows[0], {
      observed_differs_from_retrieved: true,
      recorded_differs_from_observed: true,
      recorded_differs_from_retrieved: true,
    });
    assert.notEqual(records[0]?.publisherObservedAt, records[0]?.retrievedAt);
    assert.notEqual(records[0]?.recordedAt, records[0]?.retrievedAt);
  });

  it('replays an exact stable observation ID and rejects changed assertion or trace provenance', async () => {
    const first = await repository.create(observation('obs-replay', 'current', 'revision-current-notice'));
    const replay = await repository.create(observation('obs-replay', 'current', 'revision-current-notice', {
    }));
    assert.deepEqual(replay, first);

    await expectObservationError(
      repository.create(observation('obs-replay', 'retracted', 'revision-retracted-notice')),
      'observation_id_reused',
      'report_revision_source_observation_conflict',
    );
    await expectObservationError(
      repository.create(observation('obs-replay', 'current', 'revision-current-notice', {
        traceId: 'trace-observation-retry',
      })),
      'observation_id_reused',
      'report_revision_source_observation_conflict',
    );
    assert.equal(JSON.stringify(first).includes('PRIVATE_SOURCE_TEXT'), false);
    assert.deepEqual(Object.keys(first).sort(), [
      'assertedState',
      'assertionReportRevisionId', 'datasetKind', 'observationId',
      'publisherObservedAt', 'recordedAt', 'replacementReportRevisionId', 'retrievedAt',
      'sourceId', 'targetReportRevisionId', 'traceId',
    ].sort());

    const columns = await database.executor.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'waspada' AND table_name = 'report_revision_source_observations'
       ORDER BY ordinal_position`,
    );
    assert.deepEqual(columns.rows.map(({ column_name }) => column_name), [
      'dataset_kind', 'observation_id', 'trace_id', 'source_id', 'target_report_revision_id',
      'assertion_report_revision_id', 'asserted_state', 'replacement_report_revision_id',
      'publisher_observed_at', 'retrieved_at', 'recorded_at',
    ], 'the observation table contains identifiers and typed metadata only');
  });

  it('rejects missing assertions, cross-source or cross-dataset lineage, and invalid replacement relationships', async () => {
    await expectObservationError(
      repository.create({
        ...observation('obs-no-assertion', 'current', 'revision-current-notice'),
        assertionReportRevisionId: '',
      }),
      'invalid_input',
      'report_revision_source_observation_invalid_input',
    );
    await expectObservationError(
      repository.create(observation('obs-cross-source', 'current', 'revision-source-b')),
      'source_lineage_mismatch',
      'report_revision_source_observation_source_lineage_mismatch',
    );
    await expectObservationError(
      repository.create(observation('obs-cross-dataset', 'current', 'revision-historical-only')),
      'revision_not_found',
      'report_revision_source_observation_revision_not_found',
    );
    await expectObservationError(
      repository.create(observation('obs-wrong-replacement', 'superseded', 'revision-superseded-notice', {
        replacementReportRevisionId: 'revision-wrong-replacement',
      })),
      'replacement_mismatch',
      'report_revision_source_observation_replacement_mismatch',
    );
    await expectObservationError(
      repository.create({
        ...observation('obs-current-with-replacement', 'current', 'revision-current-notice'),
        replacementReportRevisionId: 'revision-replacement',
      }),
      'invalid_input',
      'report_revision_source_observation_invalid_input',
    );
    await expectObservationError(
      repository.create(observation('obs-self-replacement', 'superseded', 'revision-superseded-notice', {
        replacementReportRevisionId: 'revision-target',
      })),
      'invalid_input',
      'report_revision_source_observation_invalid_input',
    );
    await expectObservationError(
      repository.create({
        ...observation('obs-fetch-failure', 'retracted', 'revision-retracted-notice'),
        assertionReportRevisionId: '',
      }),
      'invalid_input',
      'report_revision_source_observation_invalid_input',
    );
  });

  it('enforces same-source, same-dataset and supersession rules in SQL', async () => {
    await assert.rejects(database.executor.query(
      `INSERT INTO waspada.report_revision_source_observations
         (dataset_kind, observation_id, trace_id, source_id, target_report_revision_id,
          assertion_report_revision_id, asserted_state, retrieved_at)
       VALUES ('synthetic', 'obs-sql-cross-source', 'trace-observation-synthetic',
               'source-observation-a', 'revision-target', 'revision-source-b', 'current', $1)`,
      [RETRIEVED_AT],
    ));
    await assert.rejects(database.executor.query(
      `INSERT INTO waspada.report_revision_source_observations
         (dataset_kind, observation_id, trace_id, source_id, target_report_revision_id,
          assertion_report_revision_id, asserted_state, retrieved_at)
       VALUES ('synthetic', 'obs-sql-cross-dataset', 'trace-observation-synthetic',
               'source-observation-a', 'revision-target', 'revision-historical-only', 'current', $1)`,
      [RETRIEVED_AT],
    ));
    await assert.rejects(database.executor.query(
      `INSERT INTO waspada.report_revision_source_observations
         (dataset_kind, observation_id, trace_id, source_id, target_report_revision_id,
          assertion_report_revision_id, asserted_state, replacement_report_revision_id, retrieved_at)
       VALUES ('synthetic', 'obs-sql-wrong-replacement', 'trace-observation-synthetic',
               'source-observation-a', 'revision-target', 'revision-superseded-notice',
               'superseded', 'revision-wrong-replacement', $1)`,
      [RETRIEVED_AT],
    ), /report_revision_source_observation_replacement_mismatch/);
    await assert.rejects(database.executor.query(
      `INSERT INTO waspada.report_revision_source_observations
         (dataset_kind, observation_id, trace_id, source_id, target_report_revision_id,
          assertion_report_revision_id, asserted_state, replacement_report_revision_id, retrieved_at)
       VALUES ('synthetic', 'obs-sql-current-replacement', 'trace-observation-synthetic',
               'source-observation-a', 'revision-target', 'revision-current-notice',
               'current', 'revision-replacement', $1)`,
      [RETRIEVED_AT],
    ));
  });

  it('works under the existing L1 role without widening content access', async () => {
    await database.executor.execute(`SET ROLE ${L1_ROLE}`);
    try {
      const created = await repository.create(observation('obs-l1-role', 'current', 'revision-current-notice'));
      assert.equal(created.observationId, 'obs-l1-role');
      assert.equal(created.sourceId, 'source-observation-a');
      await assert.rejects(database.executor.query(
        `UPDATE waspada.report_revision_source_observations
         SET asserted_state = 'retracted' WHERE dataset_kind = 'synthetic' AND observation_id = 'obs-l1-role'`,
      ));
      await assert.rejects(database.executor.query(
        `DELETE FROM waspada.report_revision_source_observations
         WHERE dataset_kind = 'synthetic' AND observation_id = 'obs-l1-role'`,
      ));
    } finally {
      await database.executor.execute('RESET ROLE');
    }
  });

  it('protects stored assertions from update, delete and truncate', async () => {
    const record = await repository.create(observation('obs-append-only', 'current', 'revision-current-notice'));
    await assert.rejects(database.executor.query(
      `UPDATE waspada.report_revision_source_observations
       SET asserted_state = 'retracted'
       WHERE dataset_kind = $1 AND observation_id = $2`,
      [record.datasetKind, record.observationId],
    ), /report_revision_source_observations is append-only/);
    await assert.rejects(database.executor.query(
      `DELETE FROM waspada.report_revision_source_observations
       WHERE dataset_kind = $1 AND observation_id = $2`,
      [record.datasetKind, record.observationId],
    ), /report_revision_source_observations is append-only/);
    await assert.rejects(database.executor.execute(
      'TRUNCATE waspada.report_revision_source_observations',
    ), /append-only|cannot truncate a table referenced in a foreign key constraint/iu);
    const after = await database.executor.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM waspada.report_revision_source_observations
       WHERE dataset_kind = $1 AND observation_id = $2`,
      [record.datasetKind, record.observationId],
    );
    assert.equal(after.rows[0]?.count, '1');
  });

  it('does not change report eligibility, retrieval, public, freshness, publication, audit or outbox data', async () => {
    assert.deepEqual(await readSideEffects(), beforeSideEffects);
  });
});

function observation(
  observationId: string,
  assertedState: NewReportRevisionSourceObservation['assertedState'],
  assertionReportRevisionId: string,
  overrides: Partial<NewReportRevisionSourceObservation> = {},
): NewReportRevisionSourceObservation {
  return {
    datasetKind: 'synthetic',
    observationId,
    traceId: 'trace-observation-synthetic',
    targetReportRevisionId: 'revision-target',
    assertionReportRevisionId,
    assertedState,
    replacementReportRevisionId: assertedState === 'superseded' ? 'revision-replacement' : null,
    publisherObservedAt: OBSERVED_AT,
    retrievedAt: RETRIEVED_AT,
    ...overrides,
  };
}

async function seedFixtures(): Promise<void> {
  for (const [traceId, datasetKind] of [
    ['trace-observation-synthetic', 'synthetic'],
    ['trace-observation-historical', 'historical'],
    ['trace-observation-retry', 'synthetic'],
  ] as const) {
    await database.executor.query(
      `INSERT INTO waspada.traces (trace_id, dataset_kind, started_at, outcome, metadata)
       VALUES ($1, $2, $3, 'open', '{"fixture":"synthetic-only"}'::jsonb)`,
      [traceId, datasetKind, '2026-10-01T00:00:00Z'],
    );
  }
  for (const [sourceId, traceId] of [
    ['source-observation-a', 'trace-observation-synthetic'],
    ['source-observation-b', 'trace-observation-synthetic'],
  ] as const) {
    await database.executor.query(
      `INSERT INTO waspada.source_registry
         (source_id, trace_id, registry_version, display_name, source_kind, remit,
          access_method, approved_hosts, access_restrictions, reuse_basis, registry_status,
          approval_status, health_status, auto_acquisition_enabled, auto_publication_policy)
       VALUES ($1, $2, 1, 'Authored fixture publisher', 'other', ARRAY['test'],
               'manual_fixture', ARRAY[]::text[], ARRAY['synthetic only'], ARRAY['authored fixture'],
               'active', 'approved', 'unknown', false, 'never')`,
      [sourceId, traceId],
    );
  }

  const revisions = [
    { id: 'revision-target', source: 'source-observation-a', dataset: 'synthetic', supersedes: null },
    { id: 'revision-current-notice', source: 'source-observation-a', dataset: 'synthetic', supersedes: null },
    { id: 'revision-superseded-notice', source: 'source-observation-a', dataset: 'synthetic', supersedes: null },
    { id: 'revision-retracted-notice', source: 'source-observation-a', dataset: 'synthetic', supersedes: null },
    { id: 'revision-withdrawn-notice', source: 'source-observation-a', dataset: 'synthetic', supersedes: null },
    { id: 'revision-replacement', source: 'source-observation-a', dataset: 'synthetic', supersedes: 'revision-target' },
    { id: 'revision-target-other', source: 'source-observation-a', dataset: 'synthetic', supersedes: null },
    { id: 'revision-wrong-replacement', source: 'source-observation-a', dataset: 'synthetic', supersedes: 'revision-target-other' },
    { id: 'revision-source-b', source: 'source-observation-b', dataset: 'synthetic', supersedes: null },
    { id: 'revision-target', source: 'source-observation-a', dataset: 'historical', supersedes: null },
    { id: 'revision-historical-only', source: 'source-observation-a', dataset: 'historical', supersedes: null },
  ] as const;

  for (const revision of revisions) {
    const traceId = revision.dataset === 'synthetic'
      ? 'trace-observation-synthetic' : 'trace-observation-historical';
    const text = `PRIVATE_SOURCE_TEXT ${revision.dataset} ${revision.id}`;
    await database.executor.query(
      `INSERT INTO waspada.report_revisions
         (dataset_kind, report_revision_id, trace_id, source_id, canonical_url,
          content_hash, permitted_text, permitted_text_hash, normalization_version,
          retrieved_at, supersedes_id, revision_status, record_json)
       VALUES ($1, $2, $3, $4, $5, repeat('a', 64), $6, repeat('b', 64),
               'fixture-normalization-v1', $7, $8, 'eligible', '{"fixture":"synthetic-only"}'::jsonb)`,
      [revision.dataset, revision.id, traceId, revision.source,
        `https://private.invalid/${revision.id}`, text, RETRIEVED_AT, revision.supersedes],
    );
  }
}

interface SideEffectSnapshot {
  readonly revision_statuses: string;
  readonly source_health: string;
  readonly evidence_chunks: string;
  readonly embedding_runs: string;
  readonly grounding_contexts: string;
  readonly event_proposals: string;
  readonly event_versions: string;
  readonly freshness_transitions: string;
  readonly publication_decisions: string;
  readonly audit_records: string;
  readonly publication_outbox: string;
  readonly delivery_attempts: string;
  readonly delivery_results: string;
}

async function readSideEffects(): Promise<SideEffectSnapshot> {
  const result = await database.executor.query<SideEffectSnapshot>(
    `SELECT
       (SELECT string_agg(report_revision_id || ':' || revision_status, ',' ORDER BY report_revision_id)
        FROM waspada.report_revisions WHERE dataset_kind = 'synthetic') AS revision_statuses,
       (SELECT string_agg(source_id || ':' || health_status, ',' ORDER BY source_id)
        FROM waspada.source_registry) AS source_health,
       (SELECT count(*)::text FROM waspada.evidence_chunks) AS evidence_chunks,
       (SELECT count(*)::text FROM waspada.embedding_runs) AS embedding_runs,
       (SELECT count(*)::text FROM waspada.grounding_contexts) AS grounding_contexts,
       (SELECT count(*)::text FROM waspada.event_proposals) AS event_proposals,
       (SELECT count(*)::text FROM waspada.event_versions) AS event_versions,
       (SELECT count(*)::text FROM waspada.freshness_transitions) AS freshness_transitions,
       (SELECT count(*)::text FROM waspada.publication_decisions) AS publication_decisions,
       (SELECT count(*)::text FROM waspada.audit_records) AS audit_records,
       (SELECT count(*)::text FROM waspada.publication_outbox) AS publication_outbox,
       (SELECT count(*)::text FROM waspada.publication_outbox_delivery_attempts) AS delivery_attempts,
       (SELECT count(*)::text FROM waspada.publication_outbox_delivery_results) AS delivery_results`,
  );
  assert.ok(result.rows[0]);
  return result.rows[0];
}

async function expectObservationError(
  promise: Promise<unknown>,
  code: ReportRevisionSourceObservationError['code'],
  message: string,
): Promise<void> {
  await assert.rejects(promise, (error: unknown) => error instanceof ReportRevisionSourceObservationError
    && error.code === code && error.message === message
    && !error.message.includes('revision-target') && !error.message.includes('PRIVATE_SOURCE_TEXT'));
}
