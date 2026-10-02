import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import {
  createPublicEventUpdatesReader,
  PublicEventUpdatesError,
  PUBLIC_EVENT_UPDATES_LIMITS,
} from '../src/public-event-updates.js';
import type { SqlExecutor } from '../src/sql.js';
import { applyMigrations, readMigrations } from '../src/migrations.js';
import { createTestDatabase, type TestDatabase } from './harness.js';

const TEST_TIME = '2026-09-26T10:00:00Z';
const INITIAL_WATERMARK = '8';

interface Fixture {
  readonly traceId: string;
  readonly sourceId: string;
  readonly revisionId: string;
  readonly candidateId: string;
  readonly contextId: string;
}

interface SeedVersion {
  readonly version: number;
  readonly status?: 'published' | 'withdrawn';
}

interface ReviewInput {
  readonly eventId: string;
  readonly eventVersion: number;
  readonly status: 'approved' | 'held' | 'revoked';
  readonly changeType?: string | null;
  readonly summary?: string | null;
  readonly reviewerId?: string;
  readonly changeSequence?: string;
}

interface CandidateRow {
  readonly dataset_kind: unknown;
  readonly event_id: unknown;
  readonly event_version: unknown;
  readonly change_sequence: unknown;
  readonly change_type: unknown;
  readonly summary: unknown;
  readonly published_at: unknown;
}

let database: TestDatabase;
let fixture: Fixture;

describe('API-PUBLIC-UPDATES-READER-CORE', () => {
  before(async () => {
    database = await createTestDatabase();
    const migrations = await readMigrations(new URL('../migrations/', import.meta.url));
    const updateMigration = migrations.find(({ version }) => version === '016_public_update_feed_order');
    assert.ok(updateMigration, 'migration 016 is loaded');
    await applyMigrations(database.executor, migrations.filter(({ version }) =>
      version !== '016_public_update_feed_order'
      && version !== '017_moderator_publication_writer_role'
      && version !== '018_l1_extraction_result_verification'
      && version !== '019_l3_progress_fingerprints'
      && version !== '020_public_event_freshness_aggregate'
      && version !== '021_l1_scheduler_namespace_read'
      && version !== '022_l1_embedding_verification_reads'
      && version !== '023_l2_event_proposal_writer'
      && version !== '024_freshness_transition_ledger'
      && version !== '025_freshness_current_public_overlay'
      && version !== '026_freshness_due_run_traces'));
    await database.executor.query(
      "INSERT INTO waspada.dataset_namespace_config (singleton, dataset_kind) VALUES (true, 'live')",
    );

    fixture = await seedFixture();
    await seedEvent('event-reviewed', [{ version: 1 }]);
    await seedEvent('event-held', [{ version: 1 }]);
    await seedEvent('event-revoked', [{ version: 1 }]);
    await seedEvent('event-withdrawn', [{ version: 1 }, { version: 2, status: 'withdrawn' }]);
    await seedEvent('event-page', [{ version: 1 }, { version: 2 }]);
    await seedEvent('event-later', [{ version: 1 }]);

    await seedReviewBeforeMigration({ eventId: 'event-reviewed', eventVersion: 1, status: 'approved', changeType: 'published', summary: 'Authored fictional first update.' });
    await seedReviewBeforeMigration({ eventId: 'event-held', eventVersion: 1, status: 'approved', changeType: 'published', summary: 'Older approval must be held.' });
    await seedReviewBeforeMigration({ eventId: 'event-held', eventVersion: 1, status: 'held' });
    await seedReviewBeforeMigration({ eventId: 'event-revoked', eventVersion: 1, status: 'approved', changeType: 'published', summary: 'Older approval must be revoked.' });
    await seedReviewBeforeMigration({ eventId: 'event-revoked', eventVersion: 1, status: 'revoked' });
    await seedReviewBeforeMigration({ eventId: 'event-withdrawn', eventVersion: 1, status: 'approved', changeType: 'published', summary: 'Withdrawn event update must stay hidden.' });
    await seedReviewBeforeMigration({ eventId: 'event-page', eventVersion: 1, status: 'approved', changeType: 'published', summary: 'Authored fictional page one.' });
    await seedReviewBeforeMigration({ eventId: 'event-page', eventVersion: 2, status: 'approved', changeType: 'corrected', summary: 'Authored fictional page two.' });

    const applied = await applyMigrations(database.executor, migrations);
    assert.deepEqual(applied.applied, [
      '016_public_update_feed_order', '017_moderator_publication_writer_role',
      '018_l1_extraction_result_verification', '019_l3_progress_fingerprints',
      '020_public_event_freshness_aggregate',
      '021_l1_scheduler_namespace_read',
      '022_l1_embedding_verification_reads',
      '023_l2_event_proposal_writer',
      '024_freshness_transition_ledger',
      '025_freshness_current_public_overlay',
      '026_freshness_due_run_traces',
    ]);
  });

  after(async () => {
    await database?.close();
  });

  it('backfills a watermark and allocates every later review transactionally', async () => {
    const backfill = await database.executor.query<{ event_id: string; change_sequence: string }>(
      'SELECT event_id, change_sequence::text AS change_sequence\n'
        + 'FROM waspada.public_event_history_review_decisions\n'
        + 'ORDER BY change_sequence ASC',
    );
    assert.deepEqual(backfill.rows.map(({ event_id, change_sequence }) => [event_id, change_sequence]), [
      ['event-reviewed', '1'],
      ['event-held', '2'], ['event-held', '3'],
      ['event-revoked', '4'], ['event-revoked', '5'],
      ['event-withdrawn', '6'],
      ['event-page', '7'], ['event-page', '8'],
    ]);

    const reader = createPublicEventUpdatesReader(database.executor);
    assert.equal(await reader.readWatermark(), INITIAL_WATERMARK);

    await assert.rejects(
      database.executor.transaction(async (transaction) => {
        const sequence = await insertReview(transaction, {
          eventId: 'event-later', eventVersion: 1, status: 'revoked',
        });
        assert.equal(sequence, '9', 'the trigger assigns the next sequence inside the transaction');
        throw new Error('authored rollback fixture');
      }),
      /authored rollback fixture/u,
    );
    assert.equal(await reader.readWatermark(), INITIAL_WATERMARK,
      'the counter increment rolls back with its review decision');

    const heldSequence = await insertReview(database.executor, {
      eventId: 'event-later', eventVersion: 1, status: 'held', changeSequence: '987654321',
    });
    const approvedSequence = await insertReview(database.executor, {
      eventId: 'event-later', eventVersion: 1, status: 'approved',
      changeType: 'published', summary: 'Authored fictional later update.',
    });
    assert.deepEqual([heldSequence, approvedSequence], ['9', '10'],
      'committed review decisions receive consecutive global sequences regardless of supplied values');
    assert.equal(await reader.readWatermark(), '10');
  });

  it('reads ordered, bounded latest-approved candidates and excludes withdrawn history', async () => {
    const calls: Array<{ statement: string; parameters: readonly unknown[] }> = [];
    const reader = createPublicEventUpdatesReader(recordQueries(database.executor, calls));
    const watermark = await reader.readWatermark();
    assert.equal(watermark, '10');

    const first = await reader.readCandidates({ afterSequence: '0', throughSequence: watermark, limit: 2 });
    assert.deepEqual(first.candidates.map(({ eventId, eventVersion, changeSequence }) =>
      [eventId, eventVersion, changeSequence]), [
      ['event-reviewed', 1, '1'],
      ['event-page', 1, '7'],
    ]);
    assert.equal(first.hasMore, true, 'the limit-plus-one probe reports remaining candidates');
    assert.equal(first.candidates[0]?.publishedAt, TEST_TIME);
    assert.deepEqual(Object.keys(first.candidates[0] ?? {}).sort(), [
      'changeSequence', 'changeType', 'datasetKind', 'eventId', 'eventVersion', 'publishedAt', 'summary',
    ]);

    const second = await reader.readCandidates({ afterSequence: '7', throughSequence: watermark, limit: 2 });
    assert.deepEqual(second.candidates.map(({ eventId, eventVersion, changeSequence }) =>
      [eventId, eventVersion, changeSequence]), [
      ['event-page', 2, '8'],
      ['event-later', 1, '10'],
    ]);
    assert.equal(second.hasMore, false);

    const bounded = await reader.readCandidates({ afterSequence: '0', throughSequence: '7', limit: 100 });
    assert.deepEqual(bounded.candidates.map(({ changeSequence }) => changeSequence), ['1', '7']);
    const empty = await reader.readCandidates({ afterSequence: '10', throughSequence: '10', limit: 1 });
    assert.deepEqual(empty, { candidates: [], hasMore: false });

    assert.equal(first.candidates.some(({ eventId }) =>
      ['event-held', 'event-revoked', 'event-withdrawn'].includes(eventId)), false);
    assert.deepEqual(calls.map(({ parameters }) => parameters), [
      [], ['0', '10', 3], ['7', '10', 3], ['0', '7', 101], ['10', '10', 2],
    ]);
    for (const { statement } of calls.slice(1)) {
      assert.match(statement, /candidates\.change_sequence > \$1::bigint/u);
      assert.match(statement, /candidates\.change_sequence <= \$2::bigint/u);
      assert.match(statement, /ORDER BY candidates\.change_sequence ASC/u);
      assert.match(statement, /LIMIT \$3/u);
      assert.equal(statement.includes('event-reviewed'), false);
      assert.equal(statement.includes('reviewer_id'), false);
    }
  });

  it('validates decimal bounds and rejects malformed rows before exposing candidate data', async () => {
    const calls: string[] = [];
    const noQueryExecutor: SqlExecutor = {
      async query<Row extends object>(statement: string) {
        calls.push(statement);
        return { rows: [] as Row[] };
      },
      async execute() {},
    };
    const reader = createPublicEventUpdatesReader(noQueryExecutor);
    for (const options of [
      { afterSequence: 0, throughSequence: '10' },
      { afterSequence: '00', throughSequence: '10' },
      { afterSequence: '-1', throughSequence: '10' },
      { afterSequence: '0', throughSequence: '9223372036854775808' },
      { afterSequence: '11', throughSequence: '10' },
      { afterSequence: '0', throughSequence: '10', extra: 'private input' },
    ]) {
      await assert.rejects(reader.readCandidates(options), (error: unknown) =>
        isUpdatesError(error, 'INVALID_BOUNDS'));
    }
    await assert.rejects(reader.readCandidates({
      afterSequence: '0', throughSequence: '10', limit: PUBLIC_EVENT_UPDATES_LIMITS.maxPageSize + 1,
    }), (error: unknown) => isUpdatesError(error, 'INVALID_PAGE'));
    assert.deepEqual(calls, [], 'invalid bounds and limits are rejected before SQL');

    const malformedRows = [
      { ...makeCandidateRow(), reviewer_id: 'must-not-leak' },
      { ...makeCandidateRow(), change_sequence: 1 },
      { ...makeCandidateRow(), dataset_kind: 'synthetic' },
      { ...makeCandidateRow(), event_version: '1' },
      { ...makeCandidateRow(), change_type: 'held' },
      { ...makeCandidateRow(), summary: '   ' },
      { ...makeCandidateRow(), published_at: 'not-a-time' },
      { ...makeCandidateRow(), change_sequence: '11' },
    ];
    for (const row of malformedRows) {
      await assert.rejects(
        createPublicEventUpdatesReader(fixedRowsExecutor([row])).readCandidates({
          afterSequence: '0', throughSequence: '10', limit: 2,
        }),
        (error: unknown) => isUpdatesError(error, 'RESULT_INVALID')
          && !error.message.includes('must-not-leak'),
      );
    }
    await assert.rejects(
      createPublicEventUpdatesReader(fixedRowsExecutor([makeCandidateRow(), makeCandidateRow(), makeCandidateRow()]))
        .readCandidates({ afterSequence: '0', throughSequence: '10', limit: 1 }),
      (error: unknown) => isUpdatesError(error, 'RESULT_INVALID'),
      'the reader rejects more than the requested limit-plus-one probe',
    );
  });

  it('grants the reader only redacted update views and fails closed on missing or overflowed counter state', async () => {
    const privileges = await database.executor.query<{
      watermark_view: boolean;
      candidates_view: boolean;
      other_role_view: boolean;
      review_table: boolean;
      counter_table: boolean;
      sequence: boolean;
      counter_function: boolean;
      history_metadata: boolean;
    }>(
      `SELECT has_table_privilege('waspada_public_reader', 'waspada.public_event_updates_watermark', 'SELECT') AS watermark_view,
              has_table_privilege('waspada_public_reader', 'waspada.public_event_updates_candidates', 'SELECT') AS candidates_view,
              has_table_privilege('waspada_l1_pipeline', 'waspada.public_event_updates_candidates', 'SELECT') AS other_role_view,
              has_table_privilege('waspada_public_reader', 'waspada.public_event_history_review_decisions', 'SELECT') AS review_table,
              has_table_privilege('waspada_public_reader', 'waspada.public_event_updates_counter', 'SELECT') AS counter_table,
              has_sequence_privilege('waspada_public_reader', 'waspada.public_event_history_review_decisions_review_id_seq', 'SELECT') AS sequence,
              has_function_privilege('waspada_public_reader', 'waspada.assign_public_event_update_sequence()', 'EXECUTE') AS counter_function,
              has_table_privilege('waspada_public_reader', 'waspada.public_event_history_review_metadata', 'SELECT') AS history_metadata`,
    );
    assert.deepEqual(privileges.rows[0], {
      watermark_view: true,
      candidates_view: true,
      other_role_view: false,
      review_table: false,
      counter_table: false,
      sequence: false,
      counter_function: false,
      history_metadata: true,
    });

    const candidateColumns = await database.executor.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'waspada' AND table_name = 'public_event_updates_candidates'
       ORDER BY ordinal_position`,
    );
    assert.deepEqual(candidateColumns.rows.map(({ column_name }) => column_name), [
      'dataset_kind', 'event_id', 'event_version', 'change_sequence', 'change_type', 'summary', 'published_at',
    ]);
    assert.equal(candidateColumns.rows.some(({ column_name }) => column_name === 'reviewer_id'), false);

    await database.executor.execute('SET ROLE waspada_public_reader');
    try {
      const reader = createPublicEventUpdatesReader(database.executor);
      assert.equal(await reader.readWatermark(), '10');
      const page = await reader.readCandidates({ afterSequence: '0', throughSequence: '10', limit: 1 });
      assert.equal(page.candidates[0]?.eventId, 'event-reviewed');
      assert.equal(page.hasMore, true);
    } finally {
      await database.executor.execute('RESET ROLE');
    }

    await database.executor.execute('DELETE FROM waspada.public_event_updates_counter');
    await assert.rejects(
      insertReview(database.executor, { eventId: 'event-later', eventVersion: 1, status: 'held' }),
      /public event update sequence state is unavailable/u,
    );
    await database.executor.query(
      'INSERT INTO waspada.public_event_updates_counter (singleton, change_sequence) VALUES (true, 10)',
    );
    await database.executor.query(
      'UPDATE waspada.public_event_updates_counter SET change_sequence = 9223372036854775807 WHERE singleton = true',
    );
    await assert.rejects(
      insertReview(database.executor, { eventId: 'event-later', eventVersion: 1, status: 'held' }),
      /bigint out of range|out of range/u,
    );
  });
});

async function seedFixture(): Promise<Fixture> {
  const result: Fixture = {
    traceId: 'updates-reader-trace',
    sourceId: 'updates-reader-source',
    revisionId: 'updates-reader-revision',
    candidateId: 'updates-reader-candidate',
    contextId: 'updates-reader-context',
  };
  await database.executor.query(
    `INSERT INTO waspada.traces (trace_id, dataset_kind, started_at, outcome, metadata)
     VALUES ($1, 'live', $2, 'succeeded', '{"fixture":"authored-fiction-only"}'::jsonb)`,
    [result.traceId, TEST_TIME],
  );
  await database.executor.query(
    `INSERT INTO waspada.source_registry
       (source_id, trace_id, registry_version, display_name, source_kind, remit,
        access_method, approved_hosts, access_restrictions, reuse_basis, registry_status,
        approval_status, health_status, auto_acquisition_enabled, auto_publication_policy)
     VALUES ($1, $2, 1, 'Fictional update feed test source', 'other', ARRAY['test fixture'],
        'manual_fixture', ARRAY[]::text[], ARRAY['fictional test only'], ARRAY['test only'],
        'active', 'pending', 'unknown', false, 'never')`,
    [result.sourceId, result.traceId],
  );
  await database.executor.query(
    `INSERT INTO waspada.report_revisions
       (dataset_kind, report_revision_id, trace_id, source_id, canonical_url,
        content_hash, permitted_text, permitted_text_hash, normalization_version,
        retrieved_at, revision_status, record_json)
     VALUES ('live', $1, $2, $3, 'https://updates-reader.invalid/fixture', $4,
        'Fictional text authored only for this database test.', $5,
        'updates-reader-test-v1', $6, 'unreviewed', '{"fixture":"authored-fiction-only"}'::jsonb)`,
    [result.revisionId, result.traceId, result.sourceId, 'b'.repeat(64), 'a'.repeat(64), TEST_TIME],
  );
  await database.executor.query(
    `INSERT INTO waspada.extraction_results (dataset_kind, candidate_id, trace_id, report_revision_id, category, record_json)
     VALUES ('live', $1, $2, $3, 'group_specific_critical_notices', '{"fixture":"authored-fiction-only"}'::jsonb)`,
    [result.candidateId, result.traceId, result.revisionId],
  );
  await database.executor.query(
    `INSERT INTO waspada.grounding_contexts
       (dataset_kind, context_id, trace_id, candidate_id, retrieval_version, index_version, sufficient, record_json)
     VALUES ('live', $1, $2, $3, 'updates-reader-test-v1', 'updates-reader-index-v1', true,
       '{"fixture":"authored-fiction-only"}'::jsonb)`,
    [result.contextId, result.traceId, result.candidateId],
  );
  return result;
}

async function seedEvent(eventId: string, versions: readonly SeedVersion[]): Promise<void> {
  for (const { version, status = 'published' } of versions) {
    const proposalId = 'updates-reader-proposal-' + eventId + '-v' + version;
    const decisionId = 'updates-reader-decision-' + eventId + '-v' + version;
    const published = status === 'published';
    const record = eventRecord(eventId, version, status);
    await database.executor.transaction(async (transaction) => {
      await transaction.execute('SET CONSTRAINTS ALL DEFERRED');
      await transaction.query(
        `INSERT INTO waspada.event_proposals
           (dataset_kind, proposal_id, trace_id, candidate_id, context_id, event_id,
            base_event_version, proposed_at, record_json)
         VALUES ('live', $1, $2, $3, $4, $5, $6, $7, '{"fixture":"authored-fiction-only"}'::jsonb)`,
        [proposalId, fixture.traceId, fixture.candidateId, fixture.contextId,
          version === 1 ? null : eventId, version === 1 ? null : version - 1, TEST_TIME],
      );
      await transaction.query(
        `INSERT INTO waspada.publication_decisions
           (dataset_kind, decision_id, trace_id, proposal_id, policy_version,
            event_id, event_version, decided_at, record_json)
         VALUES ('live', $1, $2, $3, 'updates-reader-test-policy-v1', $4, $5, $6,
            '{"fixture":"authored-fiction-only"}'::jsonb)`,
        [decisionId, fixture.traceId, proposalId, eventId, version, TEST_TIME],
      );
      await transaction.query(
        `INSERT INTO waspada.event_versions
           (dataset_kind, event_id, version, trace_id, supersedes_version, title, summary,
            category, lifecycle, publication_status, withdrawal_reason, publication_decision_id,
            published_at, withdrawn_at, record_json)
         VALUES ('live', $1, $2, $3, $4, 'Fictional update feed event',
            'Authored fictional event for the bounded database test.',
            'group_specific_critical_notices', 'unknown', $5, $6, $7, $8, $9, $10::jsonb)`,
        [eventId, version, fixture.traceId, version === 1 ? null : version - 1,
          status, published ? null : 'duplicate', decisionId, published ? TEST_TIME : null,
          published ? null : TEST_TIME, JSON.stringify(record)],
      );
    });
  }
}

async function seedReviewBeforeMigration(input: ReviewInput): Promise<void> {
  await database.executor.query(
    `INSERT INTO waspada.public_event_history_review_decisions
       (dataset_kind, event_id, event_version, review_status, change_type,
        summary, reviewer_id, reviewed_at)
     VALUES ('live', $1, $2, $3, $4, $5, 'moderator-fixture', $6)`,
    [input.eventId, input.eventVersion, input.status, input.changeType ?? null,
      input.summary ?? null, TEST_TIME],
  );
}

async function insertReview(executor: SqlExecutor, input: ReviewInput): Promise<string> {
  const result = await executor.query<{ change_sequence: string }>(
    `INSERT INTO waspada.public_event_history_review_decisions
       (dataset_kind, event_id, event_version, review_status, change_type,
        summary, reviewer_id, reviewed_at, change_sequence)
     VALUES ('live', $1, $2, $3, $4, $5, 'moderator-fixture', $6, $7)
     RETURNING change_sequence::text AS change_sequence`,
    [input.eventId, input.eventVersion, input.status, input.changeType ?? null,
      input.summary ?? null, TEST_TIME, input.changeSequence ?? '999999'],
  );
  assert.equal(result.rows.length, 1);
  return result.rows[0]!.change_sequence;
}

function eventRecord(eventId: string, version: number, status: 'published' | 'withdrawn'): Record<string, unknown> {
  const published = status === 'published';
  return {
    schema_version: '2.0',
    trace_id: fixture.traceId,
    record_type: 'Event',
    dataset_kind: 'live',
    event_id: eventId,
    version,
    supersedes_version: version === 1 ? null : version - 1,
    title: 'Fictional update feed event',
    summary: 'Authored fictional event for the bounded database test.',
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
    publication_decision_id: 'updates-reader-decision-' + eventId + '-v' + version,
    published_at: published ? TEST_TIME : null,
    withdrawn_at: published ? null : TEST_TIME,
  };
}

function makeCandidateRow(): CandidateRow {
  return {
    dataset_kind: 'live',
    event_id: 'event-mocked',
    event_version: 1,
    change_sequence: '1',
    change_type: 'corrected',
    summary: 'Authored fictional update.',
    published_at: TEST_TIME,
  };
}

function recordQueries(
  executor: SqlExecutor,
  calls: Array<{ statement: string; parameters: readonly unknown[] }>,
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

function isUpdatesError(error: unknown, code: string): error is PublicEventUpdatesError {
  return error instanceof PublicEventUpdatesError && error.code === code;
}
