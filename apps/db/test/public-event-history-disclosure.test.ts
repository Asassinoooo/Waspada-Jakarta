import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import {
  createPublicEventHistoryDisclosureRepository,
  PublicEventHistoryDisclosureError,
  PUBLIC_EVENT_HISTORY_DISCLOSURE_LIMITS,
} from '../src/public-event-history-disclosure.js';
import type { SqlExecutor } from '../src/sql.js';
import { applyMigrations, readMigrations } from '../src/migrations.js';
import { createTestDatabase, type TestDatabase } from './harness.js';

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
}

interface ReviewInput {
  readonly datasetKind?: 'live' | 'historical' | 'synthetic';
  readonly eventId: string;
  readonly eventVersion: number;
  readonly status: 'approved' | 'held' | 'revoked';
  readonly changeType?: string | null;
  readonly summary?: string | null;
  readonly reviewerId?: string;
  readonly reviewedAt?: string;
}

interface DisclosureQueryRow {
  readonly current_dataset_kind: unknown;
  readonly current_event_id: unknown;
  readonly current_version: unknown;
  readonly candidate_dataset_kind: unknown;
  readonly candidate_event_id: unknown;
  readonly candidate_version: unknown;
  readonly review_dataset_kind: unknown;
  readonly review_event_id: unknown;
  readonly review_event_version: unknown;
  readonly review_status: unknown;
  readonly change_type: unknown;
  readonly summary: unknown;
  readonly reviewer_id: unknown;
  readonly reviewed_at: unknown;
}

let database: TestDatabase;
let liveFixture: Fixture;
let historicalFixture: Fixture;
let syntheticFixture: Fixture;

describe('API-PUBLIC-HISTORY-REVIEW-METADATA-CORE', () => {
  before(async () => {
    database = await createTestDatabase();
    await applyMigrations(database.executor, await readMigrations(new URL('../migrations/', import.meta.url)));
    await database.executor.query("INSERT INTO waspada.dataset_namespace_config (singleton, dataset_kind) VALUES (true, 'live')");
    liveFixture = await seedFixture('live', 'history-disclosure-live');
    historicalFixture = await seedFixture('historical', 'history-disclosure-historical');
    syntheticFixture = await seedFixture('synthetic', 'history-disclosure-synthetic');

    await seedEvent(liveFixture, 'event-reviewed', [{ version: 1 }, { version: 2 }]);
    await seedEvent(liveFixture, 'event-paged', [{ version: 1 }, { version: 2 }, { version: 3 }, { version: 4 }]);
    await seedEvent(liveFixture, 'event-partial', [{ version: 1 }, { version: 2 }]);
    await seedEvent(liveFixture, 'event-held', [{ version: 1 }]);
    await seedEvent(liveFixture, 'event-revoked', [{ version: 1 }]);
    await seedEvent(liveFixture, 'event-withdrawn', [{ version: 1 }, { version: 2, status: 'withdrawn' }]);
    await seedEvent(liveFixture, 'event-summary-limit', [{ version: 1 }]);
    await seedEvent(historicalFixture, 'event-historical-only', [{ version: 1 }]);
    await seedEvent(syntheticFixture, 'event-synthetic-only', [{ version: 1 }]);

    await seedReview({ eventId: 'event-reviewed', eventVersion: 1, status: 'approved', changeType: 'published', summary: 'Moderator-reviewed first version.' });
    await seedReview({ eventId: 'event-reviewed', eventVersion: 2, status: 'approved', changeType: 'corrected', summary: 'Moderator-reviewed exact second version.', reviewedAt: '2026-09-26T11:00:00+07:30' });
    for (const version of [1, 2, 3, 4]) {
      await seedReview({
        eventId: 'event-paged',
        eventVersion: version,
        status: 'approved',
        changeType: version === 1 ? 'published' : 'impact_changed',
        summary: 'Reviewed page version ' + version + '.',
      });
    }
    await seedReview({ eventId: 'event-partial', eventVersion: 1, status: 'approved', changeType: 'published', summary: 'Only the first version has approval.' });
    await seedReview({ eventId: 'event-held', eventVersion: 1, status: 'approved', changeType: 'published', summary: 'Older approval must be suppressed.' });
    await seedReview({ eventId: 'event-held', eventVersion: 1, status: 'held' });
    await seedReview({ eventId: 'event-revoked', eventVersion: 1, status: 'approved', changeType: 'published', summary: 'Older approval must be revoked.' });
    await seedReview({ eventId: 'event-revoked', eventVersion: 1, status: 'revoked' });
    await seedReview({ eventId: 'event-withdrawn', eventVersion: 1, status: 'approved', changeType: 'published', summary: 'Hidden with the withdrawn event.' });
    await seedReview({ eventId: 'event-summary-limit', eventVersion: 1, status: 'approved', changeType: 'published', summary: '😀'.repeat(500) });
  });

  after(async () => {
    await database?.close();
  });

  it('returns only latest approved metadata for each exact visible version', async () => {
    const result = await createPublicEventHistoryDisclosureRepository(database.executor).read('event-reviewed');
    assert.equal(result.kind, 'found');
    if (result.kind !== 'found') return;
    assert.equal(result.page.coverageComplete, true);
    assert.deepEqual(result.page.versions.map(({ eventVersion, disclosure }) => [eventVersion, disclosure?.changeType, disclosure?.summary]), [
      [1, 'published', 'Moderator-reviewed first version.'],
      [2, 'corrected', 'Moderator-reviewed exact second version.'],
    ]);
    assert.equal(result.page.versions[1]?.disclosure?.reviewedAt, '2026-09-26T03:30:00.000000Z');
    assert.equal(result.page.versions[1]?.disclosure?.reviewerId, 'moderator-fixture');
    assert.ok(result.page.versions.every(({ disclosure }) => disclosure?.reviewStatus === 'approved'));
    assert.equal('recordJson' in (result.page.versions[0] ?? {}), false);
  });

  it('keeps missing, held and revoked approval coverage observable', async () => {
    const repository = createPublicEventHistoryDisclosureRepository(database.executor);
    const partial = await repository.read('event-partial');
    const held = await repository.read('event-held');
    const revoked = await repository.read('event-revoked');

    assert.equal(partial.kind, 'found');
    if (partial.kind === 'found') {
      assert.equal(partial.page.versions.length, 2);
      assert.equal(partial.page.versions[0]?.disclosure?.reviewStatus, 'approved');
      assert.equal(partial.page.versions[1]?.disclosure, null);
      assert.equal(partial.page.coverageComplete, false);
    }
    assert.equal(held.kind, 'found');
    if (held.kind === 'found') {
      assert.equal(held.page.versions.length, 1);
      assert.equal(held.page.versions[0]?.disclosure, null);
      assert.equal(held.page.coverageComplete, false);
    }
    assert.equal(revoked.kind, 'found');
    if (revoked.kind === 'found') {
      assert.equal(revoked.page.versions[0]?.disclosure, null);
      assert.equal(revoked.page.coverageComplete, false);
    }

    const approvedRows = await database.executor.query<{ event_id: string; event_version: number }>(
      "SELECT event_id, event_version FROM waspada.public_event_history_review_metadata WHERE event_id IN ('event-held', 'event-revoked') ORDER BY event_id",
    );
    assert.deepEqual(approvedRows.rows, []);
  });

  it('reads stable keyset pages with a limit-plus-one probe and parameterized event IDs', async () => {
    const calls: Array<{ statement: string; parameters: readonly unknown[] }> = [];
    const repository = createPublicEventHistoryDisclosureRepository(recordQueries(database.executor, calls));
    const first = await repository.read('event-paged', { limit: 2 });
    assert.equal(first.kind, 'found');
    if (first.kind !== 'found') return;
    assert.deepEqual(first.page.versions.map(({ eventVersion }) => eventVersion), [1, 2]);
    assert.equal(first.page.nextAfterVersion, 2);
    assert.equal(first.page.coverageComplete, true);

    const second = await repository.read('event-paged', { limit: 2, afterVersion: 2 });
    assert.equal(second.kind, 'found');
    if (second.kind !== 'found') return;
    assert.deepEqual(second.page.versions.map(({ eventVersion }) => eventVersion), [3, 4]);
    assert.equal(second.page.nextAfterVersion, null);
    assert.equal(calls.length, 2);
    for (const { statement, parameters } of calls) {
      assert.match(statement, /event_id = \$1/u);
      assert.match(statement, /version > \$2/u);
      assert.match(statement, /LIMIT \$3/u);
      assert.equal(statement.includes('event-paged'), false);
      assert.equal(statement.includes('record_json'), false);
      assert.equal(parameters.length, 3);
    }
    assert.deepEqual(calls[0]?.parameters, ['event-paged', 0, 3]);
    assert.deepEqual(calls[1]?.parameters, ['event-paged', 2, 3]);
  });

  it('hides withdrawn, historical, synthetic and absent events', async () => {
    const repository = createPublicEventHistoryDisclosureRepository(database.executor);
    for (const eventId of ['event-withdrawn', 'event-historical-only', 'event-synthetic-only', 'event-missing']) {
      assert.deepEqual(await repository.read(eventId), { kind: 'missing' });
    }

    const visible = await database.executor.query<{ event_id: string; version: number }>(
      "SELECT event_id, version FROM waspada.public_event_history_versions WHERE event_id IN ('event-withdrawn', 'event-historical-only', 'event-synthetic-only')",
    );
    assert.deepEqual(visible.rows, []);

    await assert.rejects(
      seedReview({ datasetKind: 'historical', eventId: 'event-historical-only', eventVersion: 1, status: 'approved', changeType: 'published', summary: 'Must not be stored for non-live data.' }),
      /check constraint/i,
    );
    await assert.rejects(
      seedReview({ eventId: 'event-withdrawn', eventVersion: 2, status: 'approved', changeType: 'retracted', summary: 'Withdrawn tombstones are not disclosure candidates.' }),
      /foreign key constraint/i,
    );
  });

  it('accepts 500 Unicode code points and rejects invalid values at the database boundary', async () => {
    const result = await createPublicEventHistoryDisclosureRepository(database.executor).read('event-summary-limit');
    assert.equal(result.kind, 'found');
    if (result.kind !== 'found') return;
    const summary = result.page.versions[0]?.disclosure?.summary;
    assert.equal(summary, '😀'.repeat(500));
    assert.equal(Array.from(summary ?? '').length, 500);

    const base = { eventId: 'event-summary-limit', eventVersion: 1, reviewerId: 'moderator-boundary', reviewedAt: TEST_TIME } as const;
    await assert.rejects(seedReview({ ...base, status: 'approved', changeType: 'published', summary: '😀'.repeat(501) }), /check constraint/i);
    await assert.rejects(seedReview({ ...base, status: 'approved', changeType: 'published', summary: '   ' }), /check constraint/i);
    await assert.rejects(seedReview({ ...base, status: 'approved', changeType: 'published', summary: '\t\n' }), /check constraint/i);
    await assert.rejects(seedReview({ ...base, status: 'approved', changeType: 'invented', summary: 'Invalid label.' }), /check constraint/i);
    await assert.rejects(seedReview({ ...base, status: 'approved', changeType: 'published', summary: 'Invalid actor.', reviewerId: ' ' }), /check constraint/i);
    await assert.rejects(seedReview({ ...base, status: 'approved', changeType: 'published', summary: 'Invalid time.', reviewedAt: 'infinity' }), /check constraint/i);
    await assert.rejects(
      seedReview({ eventId: 'event-summary-limit', eventVersion: 999, status: 'approved', changeType: 'published', summary: 'Wrong exact version.' }),
      /foreign key constraint/i,
    );
    await assert.rejects(
      database.executor.query("INSERT INTO waspada.public_event_history_review_decisions (dataset_kind, event_id, event_version, review_status, change_type, summary, reviewer_id, reviewed_at) VALUES ('live', 'event-summary-limit', 1, 'approved', NULL, 'Missing label', 'moderator-missing-label', $1)", [TEST_TIME]),
      /check constraint/i,
    );
  });

  it('enforces append-only decisions and grants the public reader only the filtered view', async () => {
    await assert.rejects(database.executor.query("UPDATE waspada.public_event_history_review_decisions SET summary = 'Changed after review.' WHERE event_id = 'event-reviewed'"), /append-only/i);
    await assert.rejects(database.executor.query("DELETE FROM waspada.public_event_history_review_decisions WHERE event_id = 'event-reviewed'"), /append-only/i);
    await assert.rejects(database.executor.execute('TRUNCATE waspada.public_event_history_review_decisions'), /append-only/i);

    const privileges = await database.executor.query<{
      can_read_table: boolean;
      can_write_table: boolean;
      can_read_sequence: boolean;
      can_read_view: boolean;
      can_write_view: boolean;
    }>("SELECT has_table_privilege('waspada_public_reader', 'waspada.public_event_history_review_decisions', 'SELECT') AS can_read_table, has_table_privilege('waspada_public_reader', 'waspada.public_event_history_review_decisions', 'INSERT') AS can_write_table, has_sequence_privilege('waspada_public_reader', 'waspada.public_event_history_review_decisions_review_id_seq', 'SELECT') AS can_read_sequence, has_table_privilege('waspada_public_reader', 'waspada.public_event_history_review_metadata', 'SELECT') AS can_read_view, has_table_privilege('waspada_public_reader', 'waspada.public_event_history_review_metadata', 'INSERT') AS can_write_view");
    assert.deepEqual(privileges.rows, [{
      can_read_table: false,
      can_write_table: false,
      can_read_sequence: false,
      can_read_view: true,
      can_write_view: false,
    }]);

    const columns = await database.executor.query<{ column_name: string }>("SELECT column_name FROM information_schema.columns WHERE table_schema = 'waspada' AND table_name = 'public_event_history_review_metadata' ORDER BY ordinal_position");
    assert.deepEqual(columns.rows.map(({ column_name }) => column_name), [
      'dataset_kind', 'event_id', 'event_version', 'review_status', 'change_type', 'summary', 'reviewer_id', 'reviewed_at',
    ]);
  });

  it('rejects duplicate, mismatched and malformed rows with stable redacted errors', async () => {
    const base = makeRow();
    const offsetResult = await createPublicEventHistoryDisclosureRepository(
      fixedRowsExecutor([{ ...base, reviewed_at: '2026-09-26T10:00:00+07:30' }]),
    ).read('event-requested');
    assert.equal(offsetResult.kind, 'found');
    if (offsetResult.kind === 'found') {
      assert.equal(offsetResult.page.versions[0]?.disclosure?.reviewedAt, '2026-09-26T10:00:00+07:30');
    }
    await assert.rejects(
      createPublicEventHistoryDisclosureRepository(fixedRowsExecutor([base, base])).read('event-requested'),
      (error: unknown) => isDisclosureError(error, 'RESULT_INVALID'),
    );
    await assert.rejects(
      createPublicEventHistoryDisclosureRepository(fixedRowsExecutor([{ ...base, review_event_version: 2 }])).read('event-requested'),
      (error: unknown) => isDisclosureError(error, 'RESULT_INVALID'),
    );
    await assert.rejects(
      createPublicEventHistoryDisclosureRepository(fixedRowsExecutor([{ ...base, candidate_event_id: 'private-other-event' }])).read('event-requested'),
      (error: unknown) => isDisclosureError(error, 'RESULT_INVALID') && !error.message.includes('private-other-event'),
    );

    for (const invalid of [
      { ...base, review_status: 'held' },
      { ...base, change_type: 'invented' },
      { ...base, summary: '😀'.repeat(501) },
      { ...base, summary: '  ' },
      { ...base, reviewer_id: 'secret reviewer id' },
      { ...base, reviewed_at: 'not-a-time' },
      { ...base, reviewed_at: '2026-09-26T10:00:00+07:90' },
      { ...base, review_dataset_kind: 'synthetic' },
    ]) {
      await assert.rejects(
        createPublicEventHistoryDisclosureRepository(fixedRowsExecutor([invalid])).read('event-requested'),
        (error: unknown) => isDisclosureError(error, 'RESULT_INVALID') && !error.message.includes('secret reviewer id'),
      );
    }

    const invalidInputCalls: string[] = [];
    const noQueryExecutor: SqlExecutor = {
      async query<Row extends object>(statement: string) {
        invalidInputCalls.push(statement);
        return { rows: [] as Row[] };
      },
      async execute() {},
    };
    const repository = createPublicEventHistoryDisclosureRepository(noQueryExecutor);
    await assert.rejects(repository.read('private event value'), (error: unknown) =>
      isDisclosureError(error, 'INVALID_EVENT_ID') && !error.message.includes('private event value'));
    await assert.rejects(repository.read('event-requested', {
      limit: PUBLIC_EVENT_HISTORY_DISCLOSURE_LIMITS.maxPageSize + 1,
    }), (error: unknown) => isDisclosureError(error, 'INVALID_PAGE'));
    await assert.rejects(repository.read('event-requested', { unexpected: 'private option' }), (error: unknown) =>
      isDisclosureError(error, 'INVALID_PAGE') && !error.message.includes('private option'));
    assert.deepEqual(invalidInputCalls, []);
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
  await database.executor.query(
    "INSERT INTO waspada.traces (trace_id, dataset_kind, started_at, outcome, metadata) VALUES ($1, $2, $3, 'succeeded', $4::jsonb)",
    [fixture.traceId, datasetKind, TEST_TIME, JSON.stringify({ fixture: 'authored-fiction-only' })],
  );
  await database.executor.query(
    "INSERT INTO waspada.source_registry (source_id, trace_id, registry_version, display_name, source_kind, remit, access_method, approved_hosts, access_restrictions, reuse_basis, registry_status, approval_status, health_status, auto_acquisition_enabled, auto_publication_policy) VALUES ($1, $2, 1, 'Fictional history metadata test source', 'other', ARRAY['test fixture'], 'manual_fixture', ARRAY[]::text[], ARRAY['fictional test only'], ARRAY['test only'], 'active', 'pending', 'unknown', false, 'never')",
    [fixture.sourceId, fixture.traceId],
  );
  await database.executor.query(
    "INSERT INTO waspada.report_revisions (dataset_kind, report_revision_id, trace_id, source_id, canonical_url, content_hash, permitted_text, permitted_text_hash, normalization_version, retrieved_at, revision_status, record_json) VALUES ($1, $2, $3, $4, $5, $6, 'Fictional text authored for a database test.', $7, 'history-metadata-test-v1', $8, 'unreviewed', $9::jsonb)",
    [datasetKind, fixture.revisionId, fixture.traceId, fixture.sourceId, 'https://' + prefix + '.invalid/fixture', 'b'.repeat(64), 'a'.repeat(64), TEST_TIME, JSON.stringify({ fixture: 'authored-fiction-only' })],
  );
  await database.executor.query(
    "INSERT INTO waspada.extraction_results (dataset_kind, candidate_id, trace_id, report_revision_id, category, record_json) VALUES ($1, $2, $3, $4, 'group_specific_critical_notices', $5::jsonb)",
    [datasetKind, fixture.candidateId, fixture.traceId, fixture.revisionId, JSON.stringify({ fixture: 'authored-fiction-only' })],
  );
  await database.executor.query(
    "INSERT INTO waspada.grounding_contexts (dataset_kind, context_id, trace_id, candidate_id, retrieval_version, index_version, sufficient, record_json) VALUES ($1, $2, $3, $4, 'history-metadata-test-v1', 'history-metadata-index-v1', true, $5::jsonb)",
    [datasetKind, fixture.contextId, fixture.traceId, fixture.candidateId, JSON.stringify({ fixture: 'authored-fiction-only' })],
  );
  return fixture;
}

async function seedEvent(fixture: Fixture, eventId: string, versions: readonly SeedVersion[]): Promise<void> {
  for (const { version, status = 'published' } of versions) {
    const proposalId = fixture.prefix + '-proposal-' + eventId + '-v' + version;
    const decisionId = fixture.prefix + '-decision-' + eventId + '-v' + version;
    const record = eventRecord(fixture, eventId, version, status);
    const publishedAt = status === 'published' ? TEST_TIME : null;
    const withdrawnAt = status === 'withdrawn' ? TEST_TIME : null;
    const withdrawalReason = status === 'withdrawn' ? 'duplicate' : null;
    await database.executor.transaction(async (transaction) => {
      await transaction.execute('SET CONSTRAINTS ALL DEFERRED');
      await transaction.query(
        "INSERT INTO waspada.event_proposals (dataset_kind, proposal_id, trace_id, candidate_id, context_id, event_id, base_event_version, proposed_at, record_json) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)",
        [fixture.datasetKind, proposalId, fixture.traceId, fixture.candidateId, fixture.contextId, version === 1 ? null : eventId, version === 1 ? null : version - 1, TEST_TIME, JSON.stringify({ fixture: 'authored-fiction-only' })],
      );
      await transaction.query(
        "INSERT INTO waspada.publication_decisions (dataset_kind, decision_id, trace_id, proposal_id, policy_version, event_id, event_version, decided_at, record_json) VALUES ($1, $2, $3, $4, 'history-metadata-test-policy-v1', $5, $6, $7, $8::jsonb)",
        [fixture.datasetKind, decisionId, fixture.traceId, proposalId, eventId, version, TEST_TIME, JSON.stringify({ fixture: 'authored-fiction-only' })],
      );
      await transaction.query(
        "INSERT INTO waspada.event_versions (dataset_kind, event_id, version, trace_id, supersedes_version, title, summary, category, lifecycle, publication_status, withdrawal_reason, publication_decision_id, published_at, withdrawn_at, record_json) VALUES ($1, $2, $3, $4, $5, 'Fictional history metadata event', 'Authored fictional event for a bounded database test.', 'group_specific_critical_notices', 'unknown', $6, $7, $8, $9, $10, $11::jsonb)",
        [fixture.datasetKind, eventId, version, fixture.traceId, version === 1 ? null : version - 1, status, withdrawalReason, decisionId, publishedAt, withdrawnAt, JSON.stringify(record)],
      );
    });
  }
}

async function seedReview(input: ReviewInput): Promise<void> {
  await database.executor.query(
    'INSERT INTO waspada.public_event_history_review_decisions (dataset_kind, event_id, event_version, review_status, change_type, summary, reviewer_id, reviewed_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
    [input.datasetKind ?? 'live', input.eventId, input.eventVersion, input.status, input.changeType ?? null, input.summary ?? null, input.reviewerId ?? 'moderator-fixture', input.reviewedAt ?? TEST_TIME],
  );
}

function eventRecord(fixture: Fixture, eventId: string, version: number, status: 'published' | 'withdrawn'): Record<string, unknown> {
  const published = status === 'published';
  return {
    schema_version: '2.0',
    trace_id: fixture.traceId,
    record_type: 'Event',
    dataset_kind: fixture.datasetKind,
    event_id: eventId,
    version,
    supersedes_version: version === 1 ? null : version - 1,
    title: 'Fictional history metadata event',
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
    publication_decision_id: fixture.prefix + '-decision-' + eventId + '-v' + version,
    published_at: published ? TEST_TIME : null,
    withdrawn_at: published ? null : TEST_TIME,
  };
}

function recordQueries(executor: SqlExecutor, calls: Array<{ statement: string; parameters: readonly unknown[] }>): SqlExecutor {
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

function makeRow(): DisclosureQueryRow {
  return {
    current_dataset_kind: 'live',
    current_event_id: 'event-requested',
    current_version: 2,
    candidate_dataset_kind: 'live',
    candidate_event_id: 'event-requested',
    candidate_version: 1,
    review_dataset_kind: 'live',
    review_event_id: 'event-requested',
    review_event_version: 1,
    review_status: 'approved',
    change_type: 'corrected',
    summary: 'Authored review fixture.',
    reviewer_id: 'moderator-fixture',
    reviewed_at: TEST_TIME,
  };
}

function isDisclosureError(error: unknown, code: string): error is PublicEventHistoryDisclosureError {
  return error instanceof PublicEventHistoryDisclosureError && error.code === code;
}
