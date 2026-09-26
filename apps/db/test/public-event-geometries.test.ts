import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import {
  createPublicEventGeometriesRepository,
  PublicEventGeometriesError,
  PUBLIC_EVENT_GEOMETRY_LIMITS,
} from '../src/public-event-geometries.js';
import type { SqlExecutor } from '../src/sql.js';
import { applyMigrations, readMigrations } from '../src/migrations.js';
import { createTestDatabase, type TestDatabase } from './harness.js';

// Every row is fictional data authored for this PGlite test. The 'live' marker
// is only a query-filter fixture; it is not live evidence, permission, or fact.
const TEST_TIME = '2026-09-26T10:00:00Z';
const TEST_HASH = 'a'.repeat(64);

type DatasetKind = 'live' | 'historical' | 'synthetic';

interface DatasetFixture {
  readonly datasetKind: DatasetKind;
  readonly prefix: string;
  readonly traceId: string;
  readonly sourceId: string;
  readonly revisionId: string;
  readonly candidateId: string;
  readonly contextId: string;
}

interface ClaimFixture {
  readonly claimId: string;
  readonly geometryIds: readonly string[];
}

interface EventVersionFixture {
  readonly eventId: string;
  readonly version: number;
  readonly status?: 'published' | 'withdrawn';
  readonly eventGeometryIds?: readonly string[];
  readonly claims?: readonly ClaimFixture[];
  readonly includeClaimGeometryLinks?: boolean;
  readonly recordJson?: unknown;
}

let testDatabase: TestDatabase;
let liveFixture: DatasetFixture;

describe('public event geometry reader', () => {
  before(async () => {
    testDatabase = await createTestDatabase();
    await applyMigrations(testDatabase.executor, await readMigrations(new URL('../migrations/', import.meta.url)));
    await testDatabase.executor.query(
      "INSERT INTO waspada.dataset_namespace_config (singleton, dataset_kind) VALUES (true, 'live')",
    );

    liveFixture = await seedDataset(testDatabase, 'live', 'geometry-fixture-live');
    const historicalFixture = await seedDataset(testDatabase, 'historical', 'geometry-fixture-historical');
    const syntheticFixture = await seedDataset(testDatabase, 'synthetic', 'geometry-fixture-synthetic');

    for (const geometryId of [
      'geo-event-old', 'geo-claim-old', 'geo-event', 'geo-claim', 'geo-shared',
      'geo-version-old', 'geo-version-old-claim', 'geo-version-current',
      'geo-version-current-claim', 'geo-withdrawn-old', 'geo-proposal-only',
      'geo-unreferenced', 'geo-stale-link', 'geo-bad-scope', 'geo-bad-envelope',
    ]) {
      await seedGeometry(testDatabase, liveFixture, geometryId);
    }
    await seedGeometry(testDatabase, historicalFixture, 'geo-historical');
    await seedGeometry(testDatabase, syntheticFixture, 'geo-synthetic');

    await seedEventVersion(testDatabase, liveFixture, {
      eventId: 'event-main',
      version: 1,
      eventGeometryIds: ['geo-event-old'],
      claims: [{ claimId: 'claim-main', geometryIds: ['geo-claim-old'] }],
    });
    await seedEventVersion(testDatabase, liveFixture, {
      eventId: 'event-main',
      version: 2,
      eventGeometryIds: ['geo-event', 'geo-shared'],
      claims: [{ claimId: 'claim-main', geometryIds: ['geo-claim', 'geo-shared'] }],
    });

    await seedEventVersion(testDatabase, liveFixture, {
      eventId: 'event-versioned',
      version: 1,
      eventGeometryIds: ['geo-version-old'],
      claims: [{ claimId: 'claim-versioned', geometryIds: ['geo-version-old-claim'] }],
    });
    await seedEventVersion(testDatabase, liveFixture, {
      eventId: 'event-versioned',
      version: 2,
      eventGeometryIds: ['geo-version-current'],
      claims: [{ claimId: 'claim-versioned', geometryIds: ['geo-version-current-claim'] }],
    });

    await seedEventVersion(testDatabase, liveFixture, {
      eventId: 'event-withdrawn',
      version: 1,
      eventGeometryIds: ['geo-withdrawn-old'],
      claims: [{ claimId: 'claim-withdrawn', geometryIds: [] }],
    });
    await seedEventVersion(testDatabase, liveFixture, {
      eventId: 'event-withdrawn',
      version: 2,
      status: 'withdrawn',
    });

    // A valid claim in an older version has a normalized link. Its current
    // version repeats the scope ID without a current-version relation row.
    await seedEventVersion(testDatabase, liveFixture, {
      eventId: 'event-stale-claim-link',
      version: 1,
      claims: [{ claimId: 'claim-stale-link', geometryIds: ['geo-stale-link'] }],
    });
    await seedEventVersion(testDatabase, liveFixture, {
      eventId: 'event-stale-claim-link',
      version: 2,
      claims: [{ claimId: 'claim-stale-link', geometryIds: ['geo-stale-link'] }],
      includeClaimGeometryLinks: false,
    });

    await seedEventVersion(testDatabase, liveFixture, {
      eventId: 'event-malformed-scope',
      version: 1,
      recordJson: malformedScopeEventRecord(liveFixture, 'event-malformed-scope', 1),
    });
    const envelopeEvent = createEventRecord(liveFixture, 'event-malformed-envelope', 1, 'published', ['geo-bad-envelope'], [
      { claimId: 'claim-envelope', geometryIds: [] },
    ], 'geometry-fixture-live-decision-event-malformed-envelope-v1');
    envelopeEvent.event_id = 'different-event-id';
    await seedEventVersion(testDatabase, liveFixture, {
      eventId: 'event-malformed-envelope',
      version: 1,
      eventGeometryIds: ['geo-bad-envelope'],
      claims: [{ claimId: 'claim-envelope', geometryIds: [] }],
      recordJson: envelopeEvent,
    });
    await seedEventVersion(testDatabase, historicalFixture, {
      eventId: 'event-historical',
      version: 1,
      eventGeometryIds: ['geo-historical'],
      claims: [{ claimId: 'claim-historical', geometryIds: [] }],
    });
    await seedEventVersion(testDatabase, syntheticFixture, {
      eventId: 'event-synthetic',
      version: 1,
      eventGeometryIds: ['geo-synthetic'],
      claims: [{ claimId: 'claim-synthetic', geometryIds: [] }],
    });
    await seedUnpublishedProposal(testDatabase, liveFixture, 'geo-proposal-only');
  });

  after(async () => {
    await testDatabase?.close();
  });

  it('exposes only current published live event and normalized claim scope references', async () => {
    const result = await testDatabase.executor.query<{
      dataset_kind: string;
      geometry_id: string;
      record_json: Record<string, unknown>;
    }>(
      'SELECT dataset_kind, geometry_id, record_json '
        + 'FROM waspada.public_event_geometries ORDER BY geometry_id',
    );

    assert.deepEqual(result.rows.map(({ geometry_id }) => geometry_id), [
      'geo-claim',
      'geo-event',
      'geo-shared',
      'geo-version-current',
      'geo-version-current-claim',
    ]);
    assert.ok(result.rows.every((row) => row.dataset_kind === 'live'));
    assert.equal(result.rows.filter(({ geometry_id }) => geometry_id === 'geo-shared').length, 1);
    assert.ok(result.rows.every(({ record_json, geometry_id }) => record_json.geometry_id === geometry_id));

    const excludedIds = [
      'geo-event-old',
      'geo-claim-old',
      'geo-version-old',
      'geo-version-old-claim',
      'geo-withdrawn-old',
      'geo-proposal-only',
      'geo-unreferenced',
      'geo-stale-link',
      'geo-bad-scope',
      'geo-bad-envelope',
      'geo-historical',
      'geo-synthetic',
    ];
    assert.ok(excludedIds.every((geometryId) =>
      result.rows.every((row) => row.geometry_id !== geometryId)));
  });

  it('handles malformed scope arrays and identity mismatches without expanding unsafe JSON', async () => {
    const result = await testDatabase.executor.query<{ geometry_id: string }>(
      'SELECT geometry_id FROM waspada.public_event_geometries ORDER BY geometry_id',
    );
    assert.equal(result.rows.some(({ geometry_id }) => geometry_id === 'geo-bad-scope'), false);
    assert.equal(result.rows.some(({ geometry_id }) => geometry_id === 'geo-bad-envelope'), false);
  });

  it('reads exact requested IDs with a parameterized view-only query and deterministic ordering', async () => {
    const calls: { statement: string; parameters: readonly unknown[] }[] = [];
    const repository = createPublicEventGeometriesRepository(recordQueries(testDatabase.executor, calls));
    const result = await repository.read(['geo-shared', 'geo-event', 'geo-claim']);

    assert.deepEqual(result.map(({ geometryId }) => geometryId), [
      'geo-claim',
      'geo-event',
      'geo-shared',
    ]);
    assert.ok(result.every(({ datasetKind }) => datasetKind === 'live'));
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0]?.parameters, [['geo-shared', 'geo-event', 'geo-claim']]);
    assert.match(calls[0]?.statement ?? '', /FROM waspada\.public_event_geometries/iu);
    assert.match(calls[0]?.statement ?? '', /geometry_id\s*=\s*ANY\(\$1::text\[\]\)/iu);
    assert.match(calls[0]?.statement ?? '', /ORDER BY geometry\.geometry_id ASC/iu);
    assert.doesNotMatch(calls[0]?.statement ?? '', /FROM waspada\.(?:geometries|geometry_evidence|evidence_references)\b/iu);

    const injection = "geo-event' OR TRUE --";
    await assert.rejects(
      repository.read([injection]),
      (error: unknown) => error instanceof PublicEventGeometriesError
        && error.code === 'INVALID_GEOMETRY_IDS'
        && !error.message.includes(injection),
    );
    assert.equal(calls.length, 1, 'invalid input is rejected before SQL execution');
  });

  it('returns empty without querying, accepts exactly 500 IDs, and rejects overflow without truncation', async () => {
    const calls: { statement: string; parameters: readonly unknown[] }[] = [];
    const executor: SqlExecutor = {
      async query<Row extends object>(statement: string, parameters?: readonly unknown[]) {
        calls.push({ statement, parameters: parameters ?? [] });
        return { rows: [] as Row[] };
      },
      async execute() {},
    };
    const repository = createPublicEventGeometriesRepository(executor);
    assert.deepEqual(await repository.read([]), []);
    assert.equal(calls.length, 0);

    const atLimit = Array.from({ length: PUBLIC_EVENT_GEOMETRY_LIMITS.geometryIds }, (_, index) =>
      'geometry-' + String(index).padStart(3, '0'));
    assert.deepEqual(await repository.read(atLimit), []);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0]?.parameters, [atLimit]);
    assert.equal((calls[0]?.parameters[0] as readonly string[]).length, 500);

    const overLimit = [...atLimit, 'geometry-overflow'];
    await assert.rejects(
      repository.read(overLimit),
      (error: unknown) => error instanceof PublicEventGeometriesError
        && error.code === 'GEOMETRY_ID_LIMIT_EXCEEDED'
        && !error.message.includes('geometry-overflow'),
    );
    assert.equal(calls.length, 1, 'overflow is rejected before querying; no truncation occurs');
  });

  it('rejects malformed and duplicate requested IDs before querying', async () => {
    const calls: string[] = [];
    const executor: SqlExecutor = {
      async query<Row extends object>(statement: string) {
        calls.push(statement);
        return { rows: [] as Row[] };
      },
      async execute() {},
    };
    const repository = createPublicEventGeometriesRepository(executor);
    for (const input of [
      null,
      'geo-event',
      ['geo-valid', 'geo-valid'],
      [''],
      ['a'.repeat(PUBLIC_EVENT_GEOMETRY_LIMITS.identifierLength + 1)],
      ['not/one-of-the-supported-identifiers'],
    ]) {
      await assert.rejects(
        repository.read(input),
        (error: unknown) => error instanceof PublicEventGeometriesError
          && error.code === 'INVALID_GEOMETRY_IDS',
      );
    }
    assert.deepEqual(calls, []);
  });

  it('rejects duplicate, unrequested, malformed and identity-mismatched database rows with redacted errors', async () => {
    const marker = 'private-fictional-geometry-payload-marker';
    const valid = geometryResultRow('geometry-requested');
    const invalidCases: readonly { readonly name: string; readonly rows: readonly unknown[] }[] = [
      { name: 'duplicate', rows: [valid, valid] },
      { name: 'unrequested', rows: [geometryResultRow('private-unrequested-id')] },
      { name: 'wrong dataset', rows: [{ ...valid, dataset_kind: 'synthetic' }] },
      { name: 'malformed record', rows: [{ ...valid, record_json: marker }] },
      {
        name: 'overlong trace identifier',
        rows: [{
          ...valid,
          record_json: {
            ...(valid.record_json as Record<string, unknown>),
            trace_id: 't'.repeat(PUBLIC_EVENT_GEOMETRY_LIMITS.identifierLength + 1),
          },
        }],
      },
      {
        name: 'identity mismatch',
        rows: [{
          ...valid,
          record_json: { ...(valid.record_json as Record<string, unknown>), geometry_id: 'private-other-id' },
        }],
      },
      {
        name: 'wrong envelope',
        rows: [{
          ...valid,
          record_json: {
            ...(valid.record_json as Record<string, unknown>),
            dataset_kind: 'historical',
            private_marker: marker,
          },
        }],
      },
    ];

    const messages: string[] = [];
    for (const testCase of invalidCases) {
      const repository = createPublicEventGeometriesRepository(executorReturning(testCase.rows));
      await assert.rejects(
        repository.read(['geometry-requested']),
        (error: unknown) => {
          if (!(error instanceof PublicEventGeometriesError) || error.code !== 'RESULT_INVALID') return false;
          assert.ok(!error.message.includes(testCase.name));
          assert.ok(!error.message.includes('private-'));
          assert.ok(!error.message.includes(marker));
          messages.push(error.message);
          return true;
        },
      );
    }
    assert.equal(new Set(messages).size, 1, 'invalid result errors use one stable message');
    assert.equal(messages[0], 'A public geometry result could not be validated.');
  });

  it('sorts injected result rows even when a database adapter returns them out of order', async () => {
    const repository = createPublicEventGeometriesRepository(executorReturning([
      geometryResultRow('geometry-z'),
      geometryResultRow('geometry-a'),
    ]));
    const result = await repository.read(['geometry-z', 'geometry-a']);
    assert.deepEqual(result.map(({ geometryId }) => geometryId), ['geometry-a', 'geometry-z']);
  });

  it('redacts database failures and exposes only the reader view under the public role', async () => {
    const marker = 'private-database-error-marker';
    const failedExecutor: SqlExecutor = {
      async query() {
        throw new Error('database rejected a secret geometry value: ' + marker);
      },
      async execute() {},
    };
    await assert.rejects(
      createPublicEventGeometriesRepository(failedExecutor).read(['geo-event']),
      (error: unknown) => error instanceof PublicEventGeometriesError
        && error.code === 'READ_FAILED'
        && !error.message.includes('geo-event')
        && !error.message.includes(marker),
    );

    const viewOptions = await testDatabase.executor.query<{ reloptions: string[] | null }>(
      "SELECT reloptions FROM pg_class WHERE oid = 'waspada.public_event_geometries'::regclass",
    );
    assert.ok(viewOptions.rows[0]?.reloptions?.includes('security_barrier=true'));

    const repository = createPublicEventGeometriesRepository(testDatabase.executor);
    await testDatabase.executor.execute('SET ROLE waspada_public_reader');
    try {
      const result = await repository.read(['geo-event', 'geo-claim']);
      assert.deepEqual(result.map(({ geometryId }) => geometryId), ['geo-claim', 'geo-event']);
      await assert.rejects(
        testDatabase.executor.query('SELECT geometry_id FROM waspada.geometries LIMIT 1'),
        /permission denied/iu,
      );
      await assert.rejects(
        testDatabase.executor.query('SELECT geometry_id FROM waspada.geometry_evidence LIMIT 1'),
        /permission denied/iu,
      );
      await assert.rejects(
        testDatabase.executor.query('SELECT evidence_ref_id FROM waspada.evidence_references LIMIT 1'),
        /permission denied/iu,
      );
    } finally {
      await testDatabase.executor.execute('RESET ROLE');
    }
  });
});

function scope(geometryIds: readonly string[]): Record<string, unknown> {
  return {
    place_ids: [],
    service_ids: [],
    institution_ids: [],
    audience_ids: [],
    geometry_ids: [...geometryIds],
  };
}

function claimRecord(fixture: DatasetFixture, input: ClaimFixture): Record<string, unknown> {
  return {
    claim_id: input.claimId,
    text: 'Fictional claim authored for the geometry reader database test.',
    event_time: { start: null, end: null, precision: 'unknown' },
    validity: { valid_from: null, valid_until: null },
    scope: scope(input.geometryIds),
    qualifiers: [],
    support: [{
      report_revision_id: fixture.revisionId,
      permitted_text_hash: TEST_HASH,
      span_start: 0,
      span_end: 1,
      offset_unit: 'unicode_code_points',
      relation: 'supports',
    }],
    contradictions: [],
    context_evidence: [],
    origin_ids: [fixture.prefix + '-origin'],
    evidence_label: 'issuer_notice',
  };
}

function createEventRecord(
  fixture: DatasetFixture,
  eventId: string,
  version: number,
  status: 'published' | 'withdrawn',
  eventGeometryIds: readonly string[],
  claims: readonly Record<string, unknown>[],
  decisionId: string,
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
    title: 'Fictional geometry reader event',
    summary: 'Authored fictional event record for a PGlite test.',
    category: 'group_specific_critical_notices',
    tags: [],
    lifecycle: 'unknown',
    freshness: {
      status: 'current',
      evaluated_at: TEST_TIME,
      review_due_at: null,
      basis: 'unknown',
    },
    event_time: { start: null, end: null, precision: 'unknown' },
    validity: { valid_from: null, valid_until: null },
    scope: scope(eventGeometryIds),
    claims: published ? claims : [],
    impact_refs: [],
    publication_status: status,
    withdrawal_reason: published ? null : 'duplicate',
    publication_decision_id: decisionId,
    published_at: published ? TEST_TIME : null,
    withdrawn_at: published ? null : TEST_TIME,
  };
}

function malformedScopeEventRecord(
  fixture: DatasetFixture,
  eventId: string,
  version: number,
): Record<string, unknown> {
  const record = createEventRecord(
    fixture,
    eventId,
    version,
    'published',
    [],
    [],
    'geometry-fixture-live-decision-event-malformed-scope-v1',
  );
  record.scope = {
    place_ids: [],
    service_ids: [],
    institution_ids: [],
    audience_ids: [],
    geometry_ids: { unexpected: 'geo-bad-scope' },
  };
  record.claims = ['malformed-claim-scope'];
  return record;
}

async function seedDataset(
  database: TestDatabase,
  datasetKind: DatasetKind,
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
    'INSERT INTO waspada.traces (trace_id, dataset_kind, started_at, outcome, metadata) '
      + "VALUES ($1, $2, $3, 'succeeded', '{\"fixture\":\"authored-fiction-only\"}'::jsonb)",
    [fixture.traceId, datasetKind, TEST_TIME],
  );
  await database.executor.query(
    'INSERT INTO waspada.source_registry '
      + '(source_id, trace_id, registry_version, display_name, source_kind, remit, '
      + 'access_method, approved_hosts, access_restrictions, reuse_basis, registry_status, '
      + 'approval_status, health_status, auto_acquisition_enabled, auto_publication_policy) '
      + "VALUES ($1, $2, 1, 'Fictional test source', 'other', ARRAY['test fixture'], "
      + "'manual_fixture', ARRAY[]::text[], ARRAY['fictional test data only'], ARRAY['test only'], "
      + "'active', 'pending', 'unknown', false, 'never')",
    [fixture.sourceId, fixture.traceId],
  );
  await database.executor.query(
    'INSERT INTO waspada.report_revisions '
      + '(dataset_kind, report_revision_id, trace_id, source_id, canonical_url, content_hash, '
      + 'permitted_text, permitted_text_hash, normalization_version, retrieved_at, revision_status, record_json) '
      + "VALUES ($1, $2, $3, $4, $5, $6, 'Fictional text authored for a PGlite database test.', "
      + "$7, 'normalization-fixture-v1', $8, 'unreviewed', '{\"fixture\":\"authored-fiction-only\"}'::jsonb)",
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
    'INSERT INTO waspada.extraction_results '
      + '(dataset_kind, candidate_id, trace_id, report_revision_id, category, record_json) '
      + "VALUES ($1, $2, $3, $4, 'group_specific_critical_notices', '{\"fixture\":\"authored-fiction-only\"}'::jsonb)",
    [datasetKind, fixture.candidateId, fixture.traceId, fixture.revisionId],
  );
  await database.executor.query(
    'INSERT INTO waspada.grounding_contexts '
      + '(dataset_kind, context_id, trace_id, candidate_id, retrieval_version, index_version, sufficient, record_json) '
      + "VALUES ($1, $2, $3, $4, 'geometry-reader-test-v1', 'geometry-reader-index-v1', true, "
      + "'{\"fixture\":\"authored-fiction-only\"}'::jsonb)",
    [datasetKind, fixture.contextId, fixture.traceId, fixture.candidateId],
  );
  return fixture;
}

async function seedGeometry(
  database: TestDatabase,
  fixture: DatasetFixture,
  geometryId: string,
): Promise<void> {
  const record = {
    schema_version: '2.0',
    trace_id: fixture.traceId,
    record_type: 'Geometry',
    dataset_kind: fixture.datasetKind,
    geometry_id: geometryId,
    role: 'facility',
    geojson: { type: 'Point', coordinates: [106.8, -6.2] },
    coordinate_reference_system: 'OGC:CRS84',
    precision_m: null,
    precision_basis: 'unknown',
    display_label: 'Fictional test geometry',
    source_evidence: [{
      report_revision_id: fixture.revisionId,
      permitted_text_hash: TEST_HASH,
      span_start: 0,
      span_end: 1,
      offset_unit: 'unicode_code_points',
      relation: 'supports',
    }],
  };
  await database.executor.query(
    'INSERT INTO waspada.geometries '
      + '(dataset_kind, geometry_id, trace_id, role, shape, coordinate_reference_system, '
      + 'precision_basis, display_label, record_json) '
      + "VALUES ($1, $2, $3, 'facility', ST_SetSRID(ST_MakePoint(106.8, -6.2), 4326), "
      + "'OGC:CRS84', 'unknown', 'Fictional test geometry', $4::jsonb)",
    [fixture.datasetKind, geometryId, fixture.traceId, JSON.stringify(record)],
  );
}

async function seedEventVersion(
  database: TestDatabase,
  fixture: DatasetFixture,
  input: EventVersionFixture,
): Promise<void> {
  const status = input.status ?? 'published';
  const claims = status === 'published'
    ? (input.claims ?? [{ claimId: 'claim-' + input.eventId, geometryIds: [] }]).map((claim) => ({
      input: claim,
      record: claimRecord(fixture, claim),
    }))
    : [];
  const proposalId = fixture.prefix + '-proposal-' + input.eventId + '-v' + input.version;
  const decisionId = fixture.prefix + '-decision-' + input.eventId + '-v' + input.version;
  const record = input.recordJson ?? createEventRecord(
    fixture,
    input.eventId,
    input.version,
    status,
    input.eventGeometryIds ?? [],
    claims.map(({ record: claim }) => claim),
    decisionId,
  );
  const withdrawalReason = status === 'withdrawn' ? 'duplicate' : null;
  const publishedAt = status === 'published' ? TEST_TIME : null;
  const withdrawnAt = status === 'withdrawn' ? TEST_TIME : null;

  await database.executor.transaction(async (transaction) => {
    await transaction.execute('SET CONSTRAINTS ALL DEFERRED');
    await transaction.query(
      'INSERT INTO waspada.event_proposals '
        + '(dataset_kind, proposal_id, trace_id, candidate_id, context_id, event_id, base_event_version, proposed_at, record_json) '
        + "VALUES ($1, $2, $3, $4, $5, $6, $7, $8, '{\"fixture\":\"authored-fiction-only\"}'::jsonb)",
      [
        fixture.datasetKind,
        proposalId,
        fixture.traceId,
        fixture.candidateId,
        fixture.contextId,
        input.version === 1 ? null : input.eventId,
        input.version === 1 ? null : input.version - 1,
        TEST_TIME,
      ],
    );
    await transaction.query(
      'INSERT INTO waspada.publication_decisions '
        + '(dataset_kind, decision_id, trace_id, proposal_id, policy_version, event_id, event_version, decided_at, record_json) '
        + "VALUES ($1, $2, $3, $4, 'geometry-reader-test-policy-v1', $5, $6, $7, "
        + "'{\"fixture\":\"authored-fiction-only\"}'::jsonb)",
      [fixture.datasetKind, decisionId, fixture.traceId, proposalId, input.eventId, input.version, TEST_TIME],
    );
    await transaction.query(
      'INSERT INTO waspada.event_versions '
        + '(dataset_kind, event_id, version, trace_id, supersedes_version, title, summary, category, lifecycle, '
        + 'publication_status, withdrawal_reason, publication_decision_id, published_at, withdrawn_at, record_json) '
        + "VALUES ($1, $2, $3, $4, $5, 'Fictional geometry reader event', "
        + "'Authored fictional event record for a PGlite test.', 'group_specific_critical_notices', "
        + "'unknown', $6, $7, $8, $9, $10, $11::jsonb)",
      [
        fixture.datasetKind,
        input.eventId,
        input.version,
        fixture.traceId,
        input.version === 1 ? null : input.version - 1,
        status,
        withdrawalReason,
        decisionId,
        publishedAt,
        withdrawnAt,
        JSON.stringify(record),
      ],
    );

    for (const claim of claims) {
      await transaction.query(
        'INSERT INTO waspada.event_claims '
          + "(dataset_kind, event_id, event_version, claim_id, publication_status, claim_text, evidence_label, record_json) "
          + "VALUES ($1, $2, $3, $4, 'published', $5, 'issuer_notice', $6::jsonb)",
        [
          fixture.datasetKind,
          input.eventId,
          input.version,
          claim.input.claimId,
          claim.record.text,
          JSON.stringify(claim.record),
        ],
      );
      if (input.includeClaimGeometryLinks !== false) {
        for (const geometryId of claim.input.geometryIds) {
          await transaction.query(
            'INSERT INTO waspada.event_claim_geometries '
              + '(dataset_kind, event_id, event_version, claim_id, geometry_id) VALUES ($1, $2, $3, $4, $5)',
            [fixture.datasetKind, input.eventId, input.version, claim.input.claimId, geometryId],
          );
        }
      }
    }
  });
}

async function seedUnpublishedProposal(
  database: TestDatabase,
  fixture: DatasetFixture,
  geometryId: string,
): Promise<void> {
  const unpublishedClaim = claimRecord(fixture, { claimId: 'claim-unpublished', geometryIds: [geometryId] });
  await database.executor.query(
    'INSERT INTO waspada.event_proposals '
      + '(dataset_kind, proposal_id, trace_id, candidate_id, context_id, event_id, base_event_version, proposed_at, record_json) '
      + "VALUES ('live', 'proposal-unpublished-geometry', $1, $2, $3, NULL, NULL, $4, $5::jsonb)",
    [
      fixture.traceId,
      fixture.candidateId,
      fixture.contextId,
      TEST_TIME,
      JSON.stringify({
        schema_version: '2.0',
        record_type: 'EventProposal',
        dataset_kind: 'live',
        claims: [unpublishedClaim],
      }),
    ],
  );
}

function geometryResultRow(geometryId: string): Record<string, unknown> {
  return {
    dataset_kind: 'live',
    geometry_id: geometryId,
    record_json: {
      schema_version: '2.0',
      trace_id: 'geometry-fixture-live-trace',
      record_type: 'Geometry',
      dataset_kind: 'live',
      geometry_id: geometryId,
      role: 'facility',
      geojson: { type: 'Point', coordinates: [106.8, -6.2] },
      coordinate_reference_system: 'OGC:CRS84',
      precision_m: null,
      precision_basis: 'unknown',
      display_label: 'Fictional test geometry',
      source_evidence: [{
        report_revision_id: 'geometry-fixture-live-revision',
        permitted_text_hash: TEST_HASH,
        span_start: 0,
        span_end: 1,
        offset_unit: 'unicode_code_points',
        relation: 'supports',
      }],
    },
  };
}

function executorReturning(rows: readonly unknown[]): SqlExecutor {
  return {
    async query<Row extends object>() {
      return { rows: rows as Row[] };
    },
    async execute() {},
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
