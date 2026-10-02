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
    await seedScopeName('place', 'place-alpha', 1, 'approved', 'Taman Contoh');
    await seedScopeName('service', 'service-alpha', 1, 'approved', 'Transjakarta Contoh');
    await seedScopeName('institution', 'institution-alpha', 1, 'approved', 'Dinas Contoh');
    await seedScopeName('audience', 'audience-alpha', 1, 'approved', 'Pengguna Contoh');
    await seedScopeName('place', 'place-boundary', 1, 'approved', 'Lapangan Contoh');
    await seedScopeName('place', 'place-alpha-plus', 1, 'approved', 'Area Contoh Lanjutan');
    await seedScopeName('place', 'place-withheld', 1, 'approved', 'Private Withheld Scope Needle');
    await seedScopeName('place', 'place-withheld', 2, 'held', null);
    await seedEventVersion(live, 'event-tie-a', 1, 'published', FIRST);
    await seedEventVersion(live, 'event-tie-b', 1, 'published', FIRST_OFFSET);
    await seedEventVersion(live, 'event-older-c', 1, 'published', OLDER);
    await seedEventVersion(live, 'event-withdrawn', 1, 'published', WITHDRAWN);
    await seedEventVersion(live, 'event-withdrawn', 2, 'withdrawn', null);
    await seedEventVersion(synthetic, 'event-synthetic', 1, 'published', UPDATED);
    await seedEventVersion(live, 'event-filter-all', 1, 'published', '2026-09-24T10:00:00.000000Z', {
      title: 'Storm warning near Taman',
      summary: 'Fictional rain advisory for this sample.',
      category: 'disasters_weather',
      lifecycle: 'ongoing',
      freshness: 'needs_update',
      eventTimeStart: '2026-09-27T10:00:00.000000Z',
      placeIds: ['place-alpha'],
      serviceIds: ['service-alpha'],
      institutionIds: ['institution-alpha'],
      audienceIds: ['audience-alpha'],
      claimMarker: 'private-claim-body-needle',
    });
    await seedEventVersion(live, 'event-filter-boundary-start', 1, 'published', '2026-09-24T09:00:00.000000Z', {
      title: 'Inclusive start boundary event',
      category: 'disasters_weather',
      lifecycle: 'ongoing',
      freshness: 'expired',
      eventTimeStart: '2026-09-26T10:00:00.000000Z',
      placeIds: ['place-boundary'],
    });
    await seedEventVersion(live, 'event-filter-unknown-time', 1, 'published', '2026-09-24T08:00:00.000000Z', {
      title: 'Event without a known start',
      category: 'disasters_weather',
      lifecycle: 'ongoing',
      freshness: 'current',
      eventTimeStart: null,
      placeIds: ['place-alpha'],
    });
    await seedEventVersion(live, 'event-filter-date-only', 1, 'published', '2026-09-24T05:00:00.000000Z', {
      title: 'Date-only event-time fixture',
      category: 'disasters_weather',
      lifecycle: 'ongoing',
      freshness: 'current',
      eventTimeStart: '2026-09-26',
      placeIds: ['place-boundary'],
    });
    await seedEventVersion(live, 'event-search-literal', 1, 'published', '2026-09-24T07:00:00.000000Z', {
      title: 'Literal %_ marker event',
      summary: 'Only this authored public title contains these symbols.',
      category: 'crime_personal_security',
      lifecycle: 'planned',
      freshness: 'current',
      eventTimeStart: '2026-09-27T10:00:00.000001Z',
      placeIds: ['place-alpha-plus'],
    });
    await seedEventVersion(live, 'event-withheld-name', 1, 'published', '2026-09-24T06:00:00.000000Z', {
      title: 'Withheld scope fixture',
      category: 'group_specific_critical_notices',
      lifecycle: 'unknown',
      freshness: 'current',
      placeIds: ['place-withheld'],
    });
    await seedEventVersion(live, 'event-aggregate-none-current', 1, 'published', '2026-09-24T03:00:00.000000Z', {
      category: 'utilities_essential_services', freshness: 'current', lifecycle: 'ongoing',
    });
    await seedEventVersion(live, 'event-aggregate-none-expired', 1, 'published', '2026-09-24T02:00:00.000000Z', {
      category: 'utilities_essential_services', freshness: 'expired', lifecycle: 'ongoing',
    });
    await seedEventVersion(live, 'event-aggregate-all-current', 1, 'published', '2026-09-24T01:00:00.000000Z', {
      category: 'utilities_essential_services', freshness: 'current', lifecycle: 'ongoing',
      impactFreshnessStatuses: ['current', 'current'],
    });
    await database.executor.query(
      `INSERT INTO waspada.impact_versions
         (dataset_kind, impact_id, version, trace_id, event_id, event_version,
          impact_type, lifecycle, published_at, record_json)
       VALUES ('live', $1, 2, $2, $3, 1, 'other', 'ongoing', $4, $5::jsonb)`,
      [
        'event-aggregate-all-current-impact-1', live.traceId, 'event-aggregate-all-current', FIRST,
        JSON.stringify({ freshness: { status: 'needs_update' } }),
      ],
    );
    await seedEventVersion(live, 'event-aggregate-all-expired', 1, 'published', '2026-09-24T00:00:00.000000Z', {
      category: 'utilities_essential_services', freshness: 'expired', lifecycle: 'ongoing',
      impactFreshnessStatuses: ['expired', 'expired'],
    });
    await seedEventVersion(live, 'event-aggregate-needs-update', 1, 'published', '2026-09-23T23:00:00.000000Z', {
      category: 'utilities_essential_services', freshness: 'current', lifecycle: 'ongoing',
      impactFreshnessStatuses: ['needs_update'],
    });
    await seedEventVersion(live, 'event-aggregate-mixed', 1, 'published', '2026-09-24T04:00:00.000000Z', {
      category: 'utilities_essential_services', freshness: 'current', lifecycle: 'ongoing',
      impactFreshnessStatuses: ['current', 'expired'],
    });
    await seedEventVersion(live, 'event-aggregate-claim-needs-update', 1, 'published', '2026-09-23T21:00:00.000000Z', {
      category: 'utilities_essential_services', freshness: 'needs_update', lifecycle: 'ongoing',
      impactFreshnessStatuses: ['current'],
    });
    await seedEventVersion(live, 'event-aggregate-invalid-impact', 1, 'published', '2026-09-23T20:00:00.000000Z', {
      category: 'utilities_essential_services', freshness: 'current', lifecycle: 'ongoing',
      impactFreshnessStatuses: ['stale'],
    });
    await seedFreshnessTransition(live, {
      eventId: 'event-aggregate-none-current', eventVersion: 1, transitionSequence: 1,
      previousStatus: 'current', resultingStatus: 'needs_update', reason: 'review_deadline_missed',
    });
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
    assert.deepEqual(third.nextCursor, { firstPublishedAt: OLDER, eventId: 'event-older-c' });
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

    const visible = await repository.read({ limit: 100 });
    const visibleIds = visible.candidates.map(({ eventId }) => eventId);
    assert.ok(['event-tie-a', 'event-tie-b', 'event-older-c'].every((eventId) => visibleIds.includes(eventId)));
    assert.ok(!visibleIds.includes('event-withdrawn') && !visibleIds.includes('event-synthetic'),
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
      { category: 'disasters_weather' },
      { filters: null },
      { filters: { category: 'not-a-category' } },
      { filters: { lifecycle: 'unknown-state' } },
      { filters: { freshness: 'stale' } },
      { filters: { q: 'x'.repeat(121) } },
      { filters: { place_id: 'x'.repeat(129) } },
      { filters: { q: 'valid', extra: true } },
      { filters: { from: '2026-02-30T10:00:00Z' } },
      { filters: { from: '2026-01-01T00:00:00Z', to: '2025-12-31T23:59:59Z' } },
      { filters: { from: '2026-01-01T00:00:00Z', to: '2026-04-01T00:00:00.000001Z' } },
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
      [valid, valid],
    ];
    for (const rows of malformedRows) {
      await assert.rejects(
        createPublicEventListRepository(fixedRowsExecutor(rows)).read({ limit: 2 }),
        (error: unknown) => error instanceof PublicEventListError
          && error.code === 'RESULT_INVALID' && !error.message.includes(marker),
      );
    }

    const beyondProbe = ['event-a', 'event-b', 'event-c', 'event-d']
      .map((eventId) => makeRow(live, eventId, 1, FIRST));
    await assert.rejects(
      createPublicEventListRepository(fixedRowsExecutor(beyondProbe)).read({ limit: 2 }),
      (error: unknown) => error instanceof PublicEventListError
        && error.code === 'RESULT_INVALID' && !error.message.includes(marker),
      'the reader rejects results larger than the limit plus one probe row',
    );
  });

  it('filters candidates before keyset ordering and limit-plus-one probing', async () => {
    const calls: { statement: string; parameters: readonly unknown[] }[] = [];
    const repository = createPublicEventListRepository(recordQueries(database.executor, calls));
    const filters = { category: 'disasters_weather' as const };
    const first = await repository.read({ limit: 1, filters });
    assert.deepEqual(first.candidates.map(({ eventId }) => eventId), ['event-filter-all']);
    assert.deepEqual(first.nextCursor, {
      firstPublishedAt: '2026-09-24T10:00:00.000000Z',
      eventId: 'event-filter-all',
    });

    const second = await repository.read({ limit: 1, cursor: first.nextCursor, filters });
    assert.deepEqual(second.candidates.map(({ eventId }) => eventId), ['event-filter-boundary-start']);
    assert.deepEqual(second.nextCursor, {
      firstPublishedAt: '2026-09-24T09:00:00.000000Z',
      eventId: 'event-filter-boundary-start',
    });
    const third = await repository.read({ limit: 1, cursor: second.nextCursor, filters });
    assert.deepEqual(third.candidates.map(({ eventId }) => eventId), ['event-filter-unknown-time']);
    const fourth = await repository.read({ limit: 1, cursor: third.nextCursor, filters });
    assert.deepEqual(fourth.candidates.map(({ eventId }) => eventId), ['event-filter-date-only']);
    assert.equal(fourth.nextCursor, null);

    const statement = calls[0]!.statement;
    const filtersAt = statement.indexOf('filtered_candidates AS');
    const predicateAt = statement.indexOf("record_json->>'category'");
    const orderAt = statement.indexOf('ORDER BY first_published_at');
    const limitAt = statement.indexOf('LIMIT $');
    assert.ok(filtersAt >= 0 && predicateAt > filtersAt && predicateAt < orderAt && orderAt < limitAt);
    assert.deepEqual(calls.map(({ parameters }) => parameters), [
      ['disasters_weather', 2],
      ['disasters_weather', '2026-09-24T10:00:00.000000Z', 'event-filter-all', 2],
      ['disasters_weather', '2026-09-24T09:00:00.000000Z', 'event-filter-boundary-start', 2],
      ['disasters_weather', '2026-09-24T08:00:00.000000Z', 'event-filter-unknown-time', 2],
    ]);
  });

  it('matches exact enums, inclusive event-start bounds, exact place IDs, and approved public search fields', async () => {
    const repository = createPublicEventListRepository(database.executor);
    const ids = async (filters: Record<string, unknown>) =>
      (await repository.read({ limit: 100, filters })).candidates.map(({ eventId }) => eventId);

    assert.deepEqual(await ids({ category: 'crime_personal_security' }), ['event-search-literal']);
    assert.deepEqual(await ids({ category: 'utilities_essential_services' }), [
      'event-aggregate-mixed', 'event-aggregate-none-current', 'event-aggregate-none-expired',
      'event-aggregate-all-current', 'event-aggregate-all-expired', 'event-aggregate-needs-update',
      'event-aggregate-claim-needs-update', 'event-aggregate-invalid-impact',
    ]);
    assert.deepEqual(await ids({ lifecycle: 'planned' }), ['event-search-literal']);
    assert.deepEqual(await ids({ lifecycle: 'cancelled' }), []);
    assert.deepEqual(await ids({ category: 'disasters_weather', freshness: 'needs_update' }), ['event-filter-all']);
    assert.deepEqual(await ids({ category: 'disasters_weather', freshness: 'expired' }), ['event-filter-boundary-start']);
    assert.deepEqual(await ids({ place_id: ' place-alpha ' }), ['event-filter-all', 'event-filter-unknown-time']);
    assert.deepEqual(await ids({ place_id: 'place-alpha-plus' }), ['event-search-literal']);
    assert.deepEqual(await ids({ place_id: 'place-alpha-extended' }), []);

    const dateBounded = await ids({
      category: 'disasters_weather',
      from: '2026-09-26T10:00:00Z',
      to: '2026-09-27T10:00:00Z',
    });
    assert.deepEqual(dateBounded, ['event-filter-all', 'event-filter-boundary-start']);
    assert.deepEqual(await ids({ from: '2026-09-27T10:00:00Z' }), ['event-filter-all', 'event-search-literal']);
    assert.deepEqual(await ids({ to: '2026-09-26T10:00:00Z' }), [
      'event-filter-boundary-start', 'event-filter-date-only',
    ]);

    await database.executor.execute('SET ROLE waspada_public_reader');
    await database.executor.execute("SET TIME ZONE 'Asia/Jakarta'");
    try {
      assert.deepEqual(await ids({ q: 'storm warning' }), ['event-filter-all']);
      assert.deepEqual(await ids({ q: 'fictional rain' }), ['event-filter-all']);
      assert.deepEqual(await ids({ q: 'TAMAN CONTOH' }), ['event-filter-all', 'event-filter-unknown-time']);
      assert.deepEqual(await ids({ q: 'TRANSJAKARTA CONTOH' }), ['event-filter-all']);
      assert.deepEqual(await ids({ q: 'DINAS CONTOH' }), ['event-filter-all']);
      assert.deepEqual(await ids({ q: 'PENGGUNA CONTOH' }), ['event-filter-all']);
      assert.deepEqual(await ids({ q: '%_' }), ['event-search-literal']);
      assert.deepEqual(await ids({ q: 'private-claim-body-needle' }), []);
      assert.deepEqual(await ids({ q: 'private-source-body-needle' }), []);
      assert.deepEqual(await ids({ q: 'Private Withheld Scope Needle' }), []);
      assert.deepEqual(await ids({ q: 'nonmatching query' }), []);
      assert.deepEqual(await ids({
        from: '2026-09-26T00:00:00Z',
        to: '2026-09-26T00:00:00Z',
      }), ['event-filter-date-only'],
      'a date-only event start means UTC midnight regardless of database session TimeZone');
    } finally {
      await database.executor.execute("SET TIME ZONE 'UTC'");
      await database.executor.execute('RESET ROLE');
    }

    const calls: { statement: string; parameters: readonly unknown[] }[] = [];
    const query = 'literal %_ needle';
    await createPublicEventListRepository(recordQueries(database.executor, calls)).read({
      limit: 2,
      filters: { q: query },
    });
    assert.ok(calls[0]!.statement.includes('waspada.public_scope_names'));
    assert.ok(!calls[0]!.statement.includes('scope_name_review_decisions'));
    assert.ok(!calls[0]!.statement.includes('report_revisions'));
    assert.ok(!calls[0]!.statement.includes('claims'));
    assert.ok(!calls[0]!.statement.includes(query));
    assert.ok(calls[0]!.parameters.includes(query));
  });

  it('filters list pages on derived freshness before limits under the public-reader role', async () => {
    const aggregateEventIds = [
      'event-aggregate-none-current', 'event-aggregate-none-expired', 'event-aggregate-all-current',
      'event-aggregate-all-expired', 'event-aggregate-needs-update', 'event-aggregate-mixed',
      'event-aggregate-claim-needs-update', 'event-aggregate-invalid-impact',
    ];
    const before = await database.executor.query(
      `SELECT event_id, lifecycle, publication_status, record_json #>> '{freshness,status}' AS record_freshness
       FROM waspada.event_versions WHERE event_id = ANY($1::text[]) ORDER BY event_id`,
      [aggregateEventIds],
    );
    const calls: { statement: string; parameters: readonly unknown[] }[] = [];
    const repository = createPublicEventListRepository(recordQueries(database.executor, calls));

    await database.executor.execute('SET ROLE waspada_public_reader');
    try {
      const filteredBeforeLimit = await repository.read({
        limit: 1,
        filters: { category: 'utilities_essential_services', freshness: 'current' },
      });
      assert.deepEqual(filteredBeforeLimit.candidates.map(({ eventId }) => eventId), ['event-aggregate-all-current']);
      assert.deepEqual(
        (await repository.read({
          limit: 100,
          filters: { category: 'utilities_essential_services', freshness: 'expired' },
        })).candidates.map(({ eventId }) => eventId),
        ['event-aggregate-none-expired', 'event-aggregate-all-expired'],
      );
      assert.deepEqual(
        (await repository.read({
          limit: 100,
          filters: { category: 'utilities_essential_services', freshness: 'needs_update' },
        })).candidates.map(({ eventId }) => eventId),
        [
          'event-aggregate-mixed', 'event-aggregate-none-current', 'event-aggregate-needs-update',
          'event-aggregate-claim-needs-update', 'event-aggregate-invalid-impact',
        ],
      );

      const viewRows = await database.executor.query<{
        event_id: string;
        freshness_status: string;
        record_freshness: string;
        lifecycle: string;
        publication_status: string;
      }>(
        `SELECT event_id, freshness_status, record_json #>> '{freshness,status}' AS record_freshness,
                lifecycle, record_json->>'publication_status' AS publication_status
         FROM waspada.public_event_versions WHERE event_id = ANY($1::text[]) ORDER BY event_id`,
        [aggregateEventIds],
      );
      assert.deepEqual(viewRows.rows.map(({ event_id, freshness_status }) => [event_id, freshness_status]), [
        ['event-aggregate-all-current', 'current'],
        ['event-aggregate-all-expired', 'expired'],
        ['event-aggregate-claim-needs-update', 'needs_update'],
        ['event-aggregate-invalid-impact', 'needs_update'],
        ['event-aggregate-mixed', 'needs_update'],
        ['event-aggregate-needs-update', 'needs_update'],
        ['event-aggregate-none-current', 'needs_update'],
        ['event-aggregate-none-expired', 'expired'],
      ]);
      const mixed = viewRows.rows.find(({ event_id }) => event_id === 'event-aggregate-mixed');
      assert.deepEqual(mixed, {
        event_id: 'event-aggregate-mixed',
        freshness_status: 'needs_update',
        record_freshness: 'needs_update',
        lifecycle: 'ongoing',
        publication_status: 'published',
      });
      assert.ok(calls[0]!.statement.indexOf('candidate_events.freshness_status')
        < calls[0]!.statement.indexOf('ORDER BY first_published_at'));
    } finally {
      await database.executor.execute('RESET ROLE');
    }

    const after = await database.executor.query(
      `SELECT event_id, lifecycle, publication_status, record_json #>> '{freshness,status}' AS record_freshness
       FROM waspada.event_versions WHERE event_id = ANY($1::text[]) ORDER BY event_id`,
      [aggregateEventIds],
    );
    assert.deepEqual(after.rows, before.rows, 'reader projections leave event and publication rows unchanged');
  });

  it('uses the effective status for a current v1 list row while history keeps its published status', async () => {
    const repository = createPublicEventListRepository(database.executor);
    await database.executor.execute('SET ROLE waspada_public_reader');
    try {
      const page = await repository.read({
        limit: 100,
        filters: { category: 'utilities_essential_services', freshness: 'needs_update' },
      });
      const current = page.candidates.find(({ eventId }) => eventId === 'event-aggregate-none-current');
      assert.ok(current);
      assert.equal(current.eventVersion, 1);
      assert.deepEqual((current.recordJson as Record<string, unknown>).freshness, {
        status: 'needs_update', evaluated_at: FIRST, review_due_at: null, basis: 'unknown',
      });

      const history = await database.executor.query<{ freshness: unknown }>(
        `SELECT record_json->'freshness' AS freshness
         FROM waspada.public_event_history_versions
         WHERE event_id = 'event-aggregate-none-current' AND version = 1`,
      );
      assert.deepEqual(history.rows, [{
        freshness: { status: 'current', evaluated_at: FIRST, review_due_at: null, basis: 'unknown' },
      }]);
    } finally {
      await database.executor.execute('RESET ROLE');
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
     VALUES ($1, $2, $3, $4, $5, $6, 'private-source-body-needle', $7,
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

async function seedScopeName(
  entityType: 'place' | 'service' | 'institution' | 'audience',
  entityId: string,
  reviewVersion: number,
  decisionStatus: 'approved' | 'held',
  displayName: string | null,
): Promise<void> {
  await database.executor.query(
    `INSERT INTO waspada.scope_name_review_decisions
       (review_decision_id, entity_type, entity_id, locale, review_version,
        decision_status, display_name, provenance_ref, reviewer_id, decision_reason, reviewed_at)
     VALUES ($1, $2, $3, 'id-ID', $4, $5, $6, 'authored-fictional-fixture',
       'fixture-reviewer', 'fictional test decision', $7)`,
    ['scope-review-' + entityId + '-v' + reviewVersion, entityType, entityId,
      reviewVersion, decisionStatus, displayName, FIRST],
  );
}

interface EventOverrides {
  readonly title?: string;
  readonly summary?: string;
  readonly category?: string;
  readonly lifecycle?: string;
  readonly freshness?: string;
  readonly impactFreshnessStatuses?: readonly string[];
  readonly eventTimeStart?: string | null;
  readonly placeIds?: readonly string[];
  readonly serviceIds?: readonly string[];
  readonly institutionIds?: readonly string[];
  readonly audienceIds?: readonly string[];
  readonly claimMarker?: string;
}

async function seedFreshnessTransition(
  fixture: Fixture,
  transition: {
    readonly eventId: string;
    readonly eventVersion: number;
    readonly transitionSequence: number;
    readonly previousStatus: 'current' | 'needs_update' | 'expired';
    readonly resultingStatus: 'current' | 'needs_update' | 'expired';
    readonly reason: 'issuer_validity_ended' | 'review_deadline_missed';
  },
): Promise<void> {
  await database.executor.query(
    `INSERT INTO waspada.freshness_transitions
       (dataset_kind, event_id, event_version, target_kind, transition_sequence,
        previous_status, resulting_status, reason, evaluated_at, trace_id,
        idempotency_key, request_fingerprint)
     VALUES ($1, $2, $3, 'event_claim_set', $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      fixture.datasetKind, transition.eventId, transition.eventVersion, transition.transitionSequence,
      transition.previousStatus, transition.resultingStatus, transition.reason, FIRST, fixture.traceId,
      fixture.prefix + ':' + transition.eventId + ':' + transition.eventVersion + ':'
        + transition.transitionSequence,
      'e'.repeat(64),
    ],
  );
}


async function seedEventVersion(
  fixture: Fixture, eventId: string, version: number,
  status: 'published' | 'withdrawn', publishedAt: string | null,
  overrides: EventOverrides = {},
): Promise<void> {
  const withdrawnAt = status === 'withdrawn' ? WITHDRAWN : null;
  const withdrawalReason = status === 'withdrawn' ? 'duplicate' : null;
  const proposalId = fixture.prefix + '-proposal-' + eventId + '-v' + version;
  const decisionId = fixture.prefix + '-decision-' + eventId + '-v' + version;
  const record = eventRecord(fixture, eventId, version, status, publishedAt, withdrawnAt, withdrawalReason, overrides);
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
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::jsonb)`,
      [fixture.datasetKind, eventId, version, fixture.traceId, version === 1 ? null : version - 1,
        record.title, record.summary, record.category, record.lifecycle, status, withdrawalReason,
        decisionId, publishedAt, withdrawnAt, JSON.stringify(record)],
    );
    for (const [index, freshnessStatus] of (overrides.impactFreshnessStatuses ?? []).entries()) {
      const impactId = eventId + '-impact-' + (index + 1);
      await transaction.query(
        `INSERT INTO waspada.impact_versions
           (dataset_kind, impact_id, version, trace_id, event_id, event_version,
            impact_type, lifecycle, published_at, record_json)
         VALUES ($1, $2, 1, $3, $4, $5, 'other', 'ongoing', $6, $7::jsonb)`,
        [fixture.datasetKind, impactId, fixture.traceId, eventId, version, publishedAt ?? FIRST,
          JSON.stringify({ freshness: { status: freshnessStatus } })],
      );
      await transaction.query(
        `INSERT INTO waspada.event_impact_refs
           (dataset_kind, event_id, event_version, impact_id, impact_version)
         VALUES ($1, $2, $3, $4, 1)`,
        [fixture.datasetKind, eventId, version, impactId],
      );
    }
  });
}

function eventRecord(
  fixture: Fixture, eventId: string, version: number, status: 'published' | 'withdrawn',
  publishedAt: string | null, withdrawnAt: string | null, withdrawalReason: string | null,
  overrides: EventOverrides = {},
): Record<string, unknown> {
  const published = status === 'published';
  const title = overrides.title ?? 'Fictional test event';
  const summary = overrides.summary ?? 'Authored fictional content for a database test.';
  const category = overrides.category ?? 'group_specific_critical_notices';
  const lifecycle = overrides.lifecycle ?? 'unknown';
  const freshness = overrides.freshness ?? 'current';
  return {
    schema_version: '2.0', trace_id: fixture.traceId, record_type: 'Event',
    dataset_kind: fixture.datasetKind, event_id: eventId, version,
    supersedes_version: version === 1 ? null : version - 1,
    title, summary, category, tags: [], lifecycle,
    freshness: { status: freshness, evaluated_at: FIRST, review_due_at: null, basis: 'unknown' },
    event_time: { start: overrides.eventTimeStart ?? null, end: null, precision: 'unknown' },
    validity: { valid_from: null, valid_until: null },
    scope: {
      place_ids: overrides.placeIds ?? [], service_ids: overrides.serviceIds ?? [],
      institution_ids: overrides.institutionIds ?? [], audience_ids: overrides.audienceIds ?? [],
      geometry_ids: [],
    },
    claims: published
      ? [{ claim_id: 'claim-' + eventId + '-v' + version },
        ...(overrides.claimMarker === undefined ? [] : [{ claim_id: overrides.claimMarker }])]
      : [],
    impact_refs: (overrides.impactFreshnessStatuses ?? []).map((_, index) => ({
      impact_id: eventId + '-impact-' + (index + 1), version: 1,
    })),
    publication_status: status, withdrawal_reason: withdrawalReason,
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
