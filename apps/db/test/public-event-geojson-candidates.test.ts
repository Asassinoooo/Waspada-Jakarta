import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import {
  createPublicEventGeoJSONCandidateRepository,
  PublicEventGeoJSONCandidateError,
  PUBLIC_EVENT_GEOJSON_CANDIDATE_LIMITS,
  type PublicEventGeoJSONCandidate,
} from '../src/public-event-geojson-candidates.js';
import type { SqlExecutor } from '../src/sql.js';
import { applyMigrations, readMigrations } from '../src/migrations.js';
import { createTestDatabase, type TestDatabase } from './harness.js';

// These authored PGlite records are fictional query fixtures. The `live`
// marker establishes no fact, source permission, factual support, or safety.
const TEST_TIME = '2026-09-27T03:00:00Z';
const TEST_HASH = 'c'.repeat(64);
const BBOX = [106.79, -6.21, 106.81, -6.19] as const;
const AGGREGATE_BBOX = [106.84, -6.21, 106.87, -6.19] as const;

type DatasetKind = 'live' | 'historical' | 'synthetic';
type PublicationStatus = 'published' | 'withdrawn';

interface DatasetFixture {
  readonly datasetKind: DatasetKind;
  readonly prefix: string;
  readonly traceId: string;
  readonly sourceId: string;
  readonly revisionId: string;
  readonly candidateId: string;
  readonly contextId: string;
}

interface GeometrySeed {
  readonly geometryId: string;
  readonly geojson: Record<string, unknown>;
  readonly recordJson?: unknown;
}

interface ClaimSeed {
  readonly claimId: string;
  readonly geometryIds: readonly string[];
  readonly linkedGeometryIds?: readonly string[];
  readonly storeClaim?: boolean;
}

interface EventSeed {
  readonly eventId: string;
  readonly version: number;
  readonly datasetKind?: DatasetKind;
  readonly status?: PublicationStatus;
  readonly category?: string;
  readonly lifecycle?: string;
  readonly freshness?: string;
  readonly impactFreshnessStatuses?: readonly string[];
  readonly eventGeometryIds?: readonly string[];
  readonly claims?: readonly ClaimSeed[];
  readonly recordJson?: unknown;
}

let testDatabase: TestDatabase;
let liveFixture: DatasetFixture;
let historicalFixture: DatasetFixture;
let syntheticFixture: DatasetFixture;
let expectedGeometryRecords: Map<string, unknown>;

describe('public event GeoJSON candidate reader', () => {
  before(async () => {
    testDatabase = await createTestDatabase();
    await applyMigrations(testDatabase.executor, await readMigrations(new URL('../migrations/', import.meta.url)));
    await testDatabase.executor.query(
      "INSERT INTO waspada.dataset_namespace_config (singleton, dataset_kind) VALUES (true, 'live')",
    );

    liveFixture = await seedDataset(testDatabase, 'live', 'geojson-candidate-live');
    historicalFixture = await seedDataset(testDatabase, 'historical', 'geojson-candidate-historical');
    syntheticFixture = await seedDataset(testDatabase, 'synthetic', 'geojson-candidate-synthetic');
    expectedGeometryRecords = new Map();

    const geometries: GeometrySeed[] = [
      point('geo-live-point', 106.8, -6.2),
      point('geo-live-boundary', 106.81, -6.2),
      point('geo-live-outside', 106.812, -6.2),
      point('geo-live-duplicate', 106.805, -6.195),
      point('geo-unlinked', 106.803, -6.196),
      point('geo-orphan', 106.804, -6.197),
      line('geo-live-crossing', [[106.78, -6.195], [106.82, -6.195]]),
      point('geo-version-old', 106.8, -6.2),
      point('geo-version-current', 106.8, -6.2),
      point('geo-stale-link', 106.8, -6.2),
      point('geo-withdrawn-old', 106.8, -6.2),
      point('geo-malformed-record', 106.6, -6.3, {
        geometry_id: 'different-geometry-id',
      }),
      point('geo-bad-event-envelope', 106.6, -6.3),
      point('geo-filtered', 106.8, -6.195),
      point('geo-historical', 106.8, -6.2),
      point('geo-synthetic', 106.8, -6.2),
      point('geo-aggregate-none-current', 106.85, -6.2),
      point('geo-aggregate-all-current', 106.852, -6.2),
      point('geo-aggregate-all-expired', 106.854, -6.2),
      point('geo-aggregate-needs-update', 106.856, -6.2),
      point('geo-aggregate-mixed', 106.858, -6.2),
      point('geo-aggregate-claim-needs-update', 106.86, -6.2),
    ];
    for (const geometry of geometries) await seedGeometry(testDatabase, liveFixture, geometry);
    await seedGeometry(testDatabase, historicalFixture, point('geo-historical', 106.8, -6.2));
    await seedGeometry(testDatabase, syntheticFixture, point('geo-synthetic', 106.8, -6.2));

    await seedEventVersion(testDatabase, liveFixture, {
      eventId: 'event-live',
      version: 1,
      category: 'transport_road_incidents',
      lifecycle: 'ongoing',
      freshness: 'current',
      eventGeometryIds: ['geo-live-point'],
      claims: [
        {
          claimId: 'claim-live-main',
          geometryIds: [
            'geo-live-point', 'geo-live-boundary', 'geo-live-outside',
            'geo-live-crossing', 'geo-live-duplicate', 'geo-unlinked',
          ],
          linkedGeometryIds: [
            'geo-live-point', 'geo-live-boundary', 'geo-live-outside',
            'geo-live-crossing', 'geo-live-duplicate',
          ],
        },
        { claimId: 'claim-live-duplicate', geometryIds: ['geo-live-duplicate'] },
      ],
    });

    await seedEventVersion(testDatabase, liveFixture, {
      eventId: 'event-versioned',
      version: 1,
      claims: [{ claimId: 'claim-versioned', geometryIds: ['geo-version-old', 'geo-stale-link'] }],
    });
    await seedEventVersion(testDatabase, liveFixture, {
      eventId: 'event-versioned',
      version: 2,
      claims: [{
        claimId: 'claim-versioned',
        geometryIds: ['geo-version-current', 'geo-stale-link'],
        linkedGeometryIds: ['geo-version-current'],
      }],
    });

    await seedEventVersion(testDatabase, liveFixture, {
      eventId: 'event-withdrawn',
      version: 1,
      claims: [{ claimId: 'claim-withdrawn', geometryIds: ['geo-withdrawn-old'] }],
    });
    await seedEventVersion(testDatabase, liveFixture, {
      eventId: 'event-withdrawn',
      version: 2,
      status: 'withdrawn',
    });

    await seedEventVersion(testDatabase, liveFixture, {
      eventId: 'event-orphan-claim',
      version: 1,
      claims: [{ claimId: 'claim-orphan', geometryIds: ['geo-orphan'], storeClaim: false }],
    });
    const malformedEvent = createEventRecord(liveFixture, {
      eventId: 'event-bad-envelope', version: 1, claims: [claimRecord(liveFixture, {
        claimId: 'claim-bad-envelope', geometryIds: ['geo-bad-event-envelope'],
      })],
    });
    malformedEvent.event_id = 'different-event-id';
    await seedEventVersion(testDatabase, liveFixture, {
      eventId: 'event-bad-envelope',
      version: 1,
      claims: [{ claimId: 'claim-bad-envelope', geometryIds: ['geo-bad-event-envelope'] }],
      recordJson: malformedEvent,
    });

    await seedEventVersion(testDatabase, liveFixture, {
      eventId: 'event-filtered',
      version: 1,
      category: 'disasters_weather',
      lifecycle: 'resolved',
      freshness: 'expired',
      claims: [{ claimId: 'claim-filtered', geometryIds: ['geo-filtered'] }],
    });
    await seedEventVersion(testDatabase, liveFixture, {
      eventId: 'event-geojson-aggregate-none-current', version: 1,
      freshness: 'current',
      claims: [{ claimId: 'claim-geojson-aggregate-none-current', geometryIds: ['geo-aggregate-none-current'] }],
    });
    await seedFreshnessTransition(liveFixture, 'event-geojson-aggregate-none-current', 1);
    await seedEventVersion(testDatabase, liveFixture, {
      eventId: 'event-geojson-aggregate-all-current', version: 1,
      freshness: 'current', impactFreshnessStatuses: ['current', 'current'],
      claims: [{ claimId: 'claim-geojson-aggregate-all-current', geometryIds: ['geo-aggregate-all-current'] }],
    });
    await testDatabase.executor.query(
      `INSERT INTO waspada.impact_versions
         (dataset_kind, impact_id, version, trace_id, event_id, event_version,
          impact_type, lifecycle, published_at, record_json)
       VALUES ('live', $1, 2, $2, $3, 1, 'other', 'ongoing', $4, $5::jsonb)`,
      [
        'event-geojson-aggregate-all-current-impact-1', liveFixture.traceId,
        'event-geojson-aggregate-all-current', TEST_TIME,
        JSON.stringify({ freshness: { status: 'needs_update' } }),
      ],
    );
    await seedEventVersion(testDatabase, liveFixture, {
      eventId: 'event-geojson-aggregate-all-expired', version: 1,
      freshness: 'expired', impactFreshnessStatuses: ['expired', 'expired'],
      claims: [{ claimId: 'claim-geojson-aggregate-all-expired', geometryIds: ['geo-aggregate-all-expired'] }],
    });
    await seedEventVersion(testDatabase, liveFixture, {
      eventId: 'event-geojson-aggregate-needs-update', version: 1,
      freshness: 'current', impactFreshnessStatuses: ['needs_update'],
      claims: [{ claimId: 'claim-geojson-aggregate-needs-update', geometryIds: ['geo-aggregate-needs-update'] }],
    });
    await seedEventVersion(testDatabase, liveFixture, {
      eventId: 'event-geojson-aggregate-mixed', version: 1,
      freshness: 'current', impactFreshnessStatuses: ['current', 'expired'],
      claims: [{ claimId: 'claim-geojson-aggregate-mixed', geometryIds: ['geo-aggregate-mixed'] }],
    });
    await seedEventVersion(testDatabase, liveFixture, {
      eventId: 'event-geojson-aggregate-claim-needs-update', version: 1,
      freshness: 'needs_update', impactFreshnessStatuses: ['current'],
      claims: [{ claimId: 'claim-geojson-aggregate-claim-needs-update', geometryIds: ['geo-aggregate-claim-needs-update'] }],
    });
    await seedEventVersion(testDatabase, historicalFixture, {
      eventId: 'event-historical', version: 1,
      claims: [{ claimId: 'claim-historical', geometryIds: ['geo-historical'] }],
    });
    await seedEventVersion(testDatabase, syntheticFixture, {
      eventId: 'event-synthetic', version: 1,
      claims: [{ claimId: 'claim-synthetic', geometryIds: ['geo-synthetic'] }],
    });

    const overflowGeometryIds = Array.from({ length: 501 }, (_, index) =>
      'geo-overflow-' + String(index).padStart(3, '0'));
    const overflowLongitudes = overflowGeometryIds.map((_, index) => 106.5 + index / 2048);
    await seedGeometryBatch(testDatabase, liveFixture, overflowGeometryIds, overflowLongitudes);
    await seedEventVersion(testDatabase, liveFixture, {
      eventId: 'event-overflow',
      version: 1,
      impactFreshnessStatuses: ['needs_update'],
      claims: [{ claimId: 'claim-overflow', geometryIds: overflowGeometryIds }],
    });
  });

  after(async () => {
    await testDatabase?.close();
  });

  it('selects exact current live claim-linked rows, applies spatial intersection, and preserves source records', async () => {
    const calls: { statement: string; parameters: readonly unknown[] }[] = [];
    const repository = createPublicEventGeoJSONCandidateRepository(recordQueries(testDatabase.executor, calls));
    const candidates = await repository.read({ bbox: BBOX });

    assert.deepEqual(candidates.map(candidateKey), [
      'event-filtered:1:geo-filtered',
      'event-live:1:geo-live-boundary',
      'event-live:1:geo-live-crossing',
      'event-live:1:geo-live-duplicate',
      'event-live:1:geo-live-point',
      'event-versioned:2:geo-version-current',
    ]);
    assert.equal(candidates.filter(({ geometryId }) => geometryId === 'geo-live-duplicate').length, 1,
      'a geometry linked by two claims returns one feature candidate');
    assert.equal(candidates.find(({ geometryId }) => geometryId === 'geo-live-crossing')?.datasetKind, 'live');
    assert.deepEqual(
      candidates.find(({ geometryId }) => geometryId === 'geo-live-point')?.geometryRecordJson,
      expectedGeometryRecords.get('geo-live-point'),
      'the original unmodified source geometry record is returned as untrusted internal JSON',
    );

    const excludedIds = [
      'geo-live-outside', 'geo-unlinked', 'geo-orphan', 'geo-version-old', 'geo-stale-link',
      'geo-withdrawn-old', 'geo-bad-event-envelope', 'geo-historical', 'geo-synthetic',
    ];
    assert.ok(excludedIds.every((geometryId) => candidates.every(({ geometryId: found }) => found !== geometryId)));
    assert.ok(calls[0]?.statement.includes('ST_Intersects(candidate.shape'));
    assert.ok(calls[0]?.statement.includes('ST_MakeEnvelope($1::double precision'));
    assert.match(calls[0]?.statement ?? '', /LIMIT 501/u);
    assert.deepEqual(calls[0]?.parameters, [
      ...BBOX, null, null, null,
    ]);
    assert.doesNotMatch(calls[0]?.statement ?? '', /FROM waspada\.(?:event_versions|event_claims|event_claim_geometries|geometries)\b/iu);
  });

  it('applies only the documented category, lifecycle, and freshness filters', async () => {
    const repository = createPublicEventGeoJSONCandidateRepository(testDatabase.executor);
    const byCategory = await repository.read({ bbox: BBOX, category: 'disasters_weather' });
    assert.deepEqual(byCategory.map(candidateKey), ['event-filtered:1:geo-filtered']);
    const byLifecycle = await repository.read({ bbox: BBOX, lifecycle: 'resolved' });
    assert.deepEqual(byLifecycle.map(candidateKey), ['event-filtered:1:geo-filtered']);
    const byFreshness = await repository.read({ bbox: BBOX, freshness: 'expired' });
    assert.deepEqual(byFreshness.map(candidateKey), ['event-filtered:1:geo-filtered']);
    const combined = await repository.read({
      bbox: BBOX,
      category: 'disasters_weather',
      lifecycle: 'resolved',
      freshness: 'expired',
    });
    assert.deepEqual(combined.map(candidateKey), ['event-filtered:1:geo-filtered']);
  });

  it('filters GeoJSON on exact aggregate freshness before the feature probe under the public-reader role', async () => {
    const aggregateEventIds = [
      'event-geojson-aggregate-none-current', 'event-geojson-aggregate-all-current',
      'event-geojson-aggregate-all-expired', 'event-geojson-aggregate-needs-update',
      'event-geojson-aggregate-mixed', 'event-geojson-aggregate-claim-needs-update',
    ];
    const before = await testDatabase.executor.query(
      `SELECT event_id, lifecycle, publication_status, record_json #>> '{freshness,status}' AS record_freshness
       FROM waspada.event_versions WHERE event_id = ANY($1::text[]) ORDER BY event_id`,
      [aggregateEventIds],
    );
    const calls: { statement: string; parameters: readonly unknown[] }[] = [];
    const repository = createPublicEventGeoJSONCandidateRepository(recordQueries(testDatabase.executor, calls));

    await testDatabase.executor.execute('SET ROLE waspada_public_reader');
    try {
      const all = await repository.read({ bbox: AGGREGATE_BBOX });
      assert.deepEqual(all.map(candidateKey), [
        'event-geojson-aggregate-all-current:1:geo-aggregate-all-current',
        'event-geojson-aggregate-all-expired:1:geo-aggregate-all-expired',
        'event-geojson-aggregate-claim-needs-update:1:geo-aggregate-claim-needs-update',
        'event-geojson-aggregate-mixed:1:geo-aggregate-mixed',
        'event-geojson-aggregate-needs-update:1:geo-aggregate-needs-update',
        'event-geojson-aggregate-none-current:1:geo-aggregate-none-current',
      ]);
      assert.deepEqual(all.map(({ eventId, freshness }) => [eventId, freshness]), [
        ['event-geojson-aggregate-all-current', 'current'],
        ['event-geojson-aggregate-all-expired', 'expired'],
        ['event-geojson-aggregate-claim-needs-update', 'needs_update'],
        ['event-geojson-aggregate-mixed', 'needs_update'],
        ['event-geojson-aggregate-needs-update', 'needs_update'],
        ['event-geojson-aggregate-none-current', 'needs_update'],
      ]);
      const mixed = all.find(({ eventId }) => eventId === 'event-geojson-aggregate-mixed');
      assert.equal(mixed?.freshness, 'needs_update');
      assert.equal(
        ((mixed?.eventRecordJson as Record<string, unknown>).freshness as Record<string, unknown>).status,
        'needs_update',
        'the current-public JSON carries the same aggregate status as its filter column',
      );
      assert.equal(
        all.find(({ eventId }) => eventId === 'event-geojson-aggregate-all-current')?.freshness,
        'current',
        'an unreferenced newer impact version does not affect the exact referenced version',
      );

      assert.deepEqual(
        (await repository.read({ bbox: AGGREGATE_BBOX, freshness: 'current' })).map(candidateKey),
        [
          'event-geojson-aggregate-all-current:1:geo-aggregate-all-current',
        ],
      );
      assert.deepEqual(
        (await repository.read({ bbox: AGGREGATE_BBOX, freshness: 'expired' })).map(candidateKey),
        ['event-geojson-aggregate-all-expired:1:geo-aggregate-all-expired'],
      );
      assert.deepEqual(
        (await repository.read({ bbox: AGGREGATE_BBOX, freshness: 'needs_update' })).map(candidateKey),
        [
          'event-geojson-aggregate-claim-needs-update:1:geo-aggregate-claim-needs-update',
          'event-geojson-aggregate-mixed:1:geo-aggregate-mixed',
          'event-geojson-aggregate-needs-update:1:geo-aggregate-needs-update',
          'event-geojson-aggregate-none-current:1:geo-aggregate-none-current',
        ],
      );
      const freshnessStatement = calls.find(({ parameters }) => parameters[6] === 'needs_update')?.statement;
      assert.ok(freshnessStatement);
      assert.ok(freshnessStatement.indexOf('candidate.freshness = $7')
        < freshnessStatement.indexOf('ORDER BY candidate.event_id'));
      assert.ok(freshnessStatement.indexOf('ORDER BY candidate.event_id')
        < freshnessStatement.indexOf('LIMIT 501'));

      const overflowLongitudes = Array.from({ length: 501 }, (_, index) => 106.5 + index / 2048);
      const overflowBBox = [106.5, -6.2, overflowLongitudes[500]!, -6.2] as const;
      assert.deepEqual(
        await repository.read({ bbox: overflowBBox, freshness: 'current' }),
        [],
        'aggregate freshness filtering removes 501 nonmatching features before the overflow probe',
      );
      await assert.rejects(
        repository.read({ bbox: overflowBBox, freshness: 'needs_update' }),
        (error: unknown) => error instanceof PublicEventGeoJSONCandidateError
          && error.code === 'FEATURE_LIMIT_EXCEEDED',
      );
    } finally {
      await testDatabase.executor.execute('RESET ROLE');
    }

    const after = await testDatabase.executor.query(
      `SELECT event_id, lifecycle, publication_status, record_json #>> '{freshness,status}' AS record_freshness
       FROM waspada.event_versions WHERE event_id = ANY($1::text[]) ORDER BY event_id`,
      [aggregateEventIds],
    );
    assert.deepEqual(after.rows, before.rows, 'GeoJSON reads leave event and publication rows unchanged');
  });

  it('accepts inclusive bbox edges and uses exact intersection without clipping', async () => {
    const repository = createPublicEventGeoJSONCandidateRepository(testDatabase.executor);
    const pointAtCorner = await repository.read({ bbox: [106.8, -6.2, 106.8, -6.2] });
    assert.ok(pointAtCorner.some(({ geometryId }) => geometryId === 'geo-live-point'));
    const atEastEdge = await repository.read({ bbox: [106.8, -6.2, 106.81, -6.2] });
    assert.ok(atEastEdge.some(({ geometryId }) => geometryId === 'geo-live-boundary'));
    assert.deepEqual(
      atEastEdge.find(({ geometryId }) => geometryId === 'geo-live-boundary')?.geometryRecordJson,
      expectedGeometryRecords.get('geo-live-boundary'),
    );
    assert.ok(!atEastEdge.some(({ geometryId }) => geometryId === 'geo-live-outside'));
  });

  it('validates the closed query and inclusive ADR-018 envelope before SQL', async () => {
    let queryCount = 0;
    const executor: SqlExecutor = {
      async query<Row extends object>() {
        queryCount += 1;
        return { rows: [] as Row[] };
      },
      async execute() {},
    };
    const repository = createPublicEventGeoJSONCandidateRepository(executor);
    const invalidQueries: unknown[] = [
      null,
      {},
      { bbox: [] },
      { bbox: [106.32, -6.4, 106.98, -5.16, 0] },
      { bbox: ['106.8', -6.2, 106.81, -6.19] },
      { bbox: [Number.NaN, -6.2, 106.81, -6.19] },
      { bbox: [106.82, -6.2, 106.81, -6.19] },
      { bbox: [106.8, -6.19, 106.81, -6.2] },
      { bbox: [106.31, -6.2, 106.81, -6.19] },
      { bbox: [106.8, -6.41, 106.81, -6.19] },
      { bbox: [106.8, -6.2, 106.99, -6.19] },
      { bbox: [106.8, -6.2, 106.81, -5.15] },
      { bbox: BBOX, extra: true },
      { bbox: BBOX, category: 'not-a-category' },
      { bbox: BBOX, lifecycle: 'unknown-state' },
      { bbox: BBOX, freshness: 'stale' },
    ];
    for (const query of invalidQueries) {
      await assert.rejects(repository.read(query), (error: unknown) =>
        error instanceof PublicEventGeoJSONCandidateError
          && error.code === 'INVALID_QUERY'
          && !error.message.includes('106.')
          && !error.message.includes('not-a-category'));
    }
    assert.equal(queryCount, 0, 'invalid query input never reaches SQL');

    const exactEnvelope = await repository.read({
      bbox: [106.32, -6.4, 106.98, -5.16],
    });
    assert.deepEqual(exactEnvelope, []);
    assert.equal(queryCount, 1, 'the inclusive envelope boundaries are accepted');
  });

  it('reads at most 501 rows, returns exactly 500 matches, and fails rather than truncating the 501st', async () => {
    const repository = createPublicEventGeoJSONCandidateRepository(testDatabase.executor);
    const longitudes = Array.from({ length: 501 }, (_, index) => 106.5 + index / 2048);
    const exactlyFiveHundred = await repository.read({
      bbox: [106.5, -6.2, longitudes[499]!, -6.2],
    });
    assert.equal(exactlyFiveHundred.length, PUBLIC_EVENT_GEOJSON_CANDIDATE_LIMITS.features);

    await assert.rejects(
      repository.read({ bbox: [106.5, -6.2, longitudes[500]!, -6.2] }),
      (error: unknown) => error instanceof PublicEventGeoJSONCandidateError
        && error.code === 'FEATURE_LIMIT_EXCEEDED'
        && !error.message.includes('geo-overflow')
        && !error.message.includes('event-overflow'),
    );
  });

  it('uses a security-barrier view and grants the public reader no direct base-table reads', async () => {
    const view = await testDatabase.executor.query<{ reloptions: string[] | null }>(
      `SELECT relation.reloptions
       FROM pg_class AS relation
       WHERE relation.oid = 'waspada.public_event_geojson_candidates'::regclass`,
    );
    assert.ok(view.rows[0]?.reloptions?.includes('security_barrier=true'));

    const privileges = await testDatabase.executor.query<{
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
         AND relation.relname IN ('public_event_geojson_candidates', 'event_versions',
           'event_claims', 'event_claim_geometries', 'geometries', 'source_registry',
           'report_revisions', 'evidence_references')
       ORDER BY relation.relname`,
    );
    const byName = new Map(privileges.rows.map((row) => [row.relation_name, row]));
    assert.deepEqual(byName.get('public_event_geojson_candidates'), {
      relation_name: 'public_event_geojson_candidates',
      can_select: true, can_insert: false, can_update: false, can_delete: false,
    });
    for (const relationName of [
      'event_versions', 'event_claims', 'event_claim_geometries', 'geometries',
      'source_registry', 'report_revisions', 'evidence_references',
    ]) {
      assert.deepEqual(byName.get(relationName), {
        relation_name: relationName,
        can_select: false, can_insert: false, can_update: false, can_delete: false,
      });
    }

    await testDatabase.executor.execute('SET ROLE waspada_public_reader');
    try {
      const repository = createPublicEventGeoJSONCandidateRepository(testDatabase.executor);
      const candidates = await repository.read({ bbox: BBOX });
      assert.ok(candidates.length > 0, 'the repository reads the filtered view under the reader role');
      for (const relation of [
        'event_versions', 'event_claims', 'event_claim_geometries', 'geometries',
        'source_registry', 'report_revisions', 'evidence_references',
      ]) {
        await assert.rejects(
          testDatabase.executor.query(`SELECT * FROM waspada.${relation} LIMIT 1`),
          /permission denied/iu,
        );
      }
    } finally {
      await testDatabase.executor.execute('RESET ROLE');
    }
  });

  it('rejects malformed, duplicate, and identity-mismatched rows with redacted errors', async () => {
    const valid = makeFakeCandidate('event-valid', 1, 'geo-valid');
    const marker = 'fictional-private-record-marker';
    const malformedRows = [
      [{ ...valid, dataset_kind: 'synthetic', private_value: marker }],
      [{ ...valid, event_version: 0 }],
      [{ ...valid, category: 'unknown-category' }],
      [{ ...valid, event_record_json: { ...valid.event_record_json, event_id: 'event-other-private' } }],
      [{ ...valid, geometry_record_json: { ...valid.geometry_record_json, geometry_id: 'geo-other-private' } }],
      [valid, valid],
    ];
    for (const rows of malformedRows) {
      await assert.rejects(
        createPublicEventGeoJSONCandidateRepository(fixedRowsExecutor(rows)).read({ bbox: BBOX }),
        (error: unknown) => error instanceof PublicEventGeoJSONCandidateError
          && error.code === 'RESULT_INVALID'
          && !error.message.includes(marker)
          && !error.message.includes('event-other-private')
          && !error.message.includes('geo-other-private'),
      );
    }
  });

  it('redacts database errors and rejects a database result that exceeds the probe bound', async () => {
    const marker = 'fictional-private-driver-error';
    const failedExecutor: SqlExecutor = {
      async query<Row extends object>() {
        throw new Error(marker) as Row;
      },
      async execute() {},
    };
    await assert.rejects(
      createPublicEventGeoJSONCandidateRepository(failedExecutor).read({ bbox: BBOX }),
      (error: unknown) => error instanceof PublicEventGeoJSONCandidateError
        && error.code === 'READ_FAILED'
        && !error.message.includes(marker),
    );

    const overProbeRows = Array.from({ length: 502 }, (_, index) =>
      makeFakeCandidate('event-fake-' + String(index).padStart(3, '0'), 1, 'geo-fake-' + String(index).padStart(3, '0')));
    await assert.rejects(
      createPublicEventGeoJSONCandidateRepository(fixedRowsExecutor(overProbeRows)).read({ bbox: BBOX }),
      (error: unknown) => error instanceof PublicEventGeoJSONCandidateError
        && error.code === 'RESULT_INVALID',
    );
  });
});

function candidateKey(candidate: PublicEventGeoJSONCandidate): string {
  return `${candidate.eventId}:${candidate.eventVersion}:${candidate.geometryId}`;
}

function point(geometryId: string, longitude: number, latitude: number, recordOverrides?: Record<string, unknown>): GeometrySeed {
  return {
    geometryId,
    geojson: { type: 'Point', coordinates: [longitude, latitude] },
    ...(recordOverrides ? { recordJson: recordOverrides } : {}),
  };
}

function line(geometryId: string, coordinates: readonly (readonly [number, number])[]): GeometrySeed {
  return { geometryId, geojson: { type: 'LineString', coordinates } };
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
    `INSERT INTO waspada.traces (trace_id, dataset_kind, started_at, outcome, metadata)
     VALUES ($1, $2, $3, 'succeeded', '{"fixture":"authored-fiction-only"}'::jsonb)`,
    [fixture.traceId, datasetKind, TEST_TIME],
  );
  await database.executor.query(
    `INSERT INTO waspada.source_registry
       (source_id, trace_id, registry_version, display_name, source_kind, remit,
        access_method, approved_hosts, access_restrictions, reuse_basis, registry_status,
        approval_status, health_status, auto_acquisition_enabled, auto_publication_policy)
     VALUES ($1, $2, 1, 'Fictional fixture source', 'other', ARRAY['test fixture'],
        'manual_fixture', ARRAY[]::text[], ARRAY['fictional data only'], ARRAY['test only'],
        'active', 'pending', 'unknown', false, 'never')`,
    [fixture.sourceId, fixture.traceId],
  );
  await database.executor.query(
    `INSERT INTO waspada.report_revisions
       (dataset_kind, report_revision_id, trace_id, source_id, canonical_url,
        content_hash, permitted_text, permitted_text_hash, normalization_version,
        retrieved_at, revision_status, record_json)
     VALUES ($1, $2, $3, $4, $5, $6, 'Fictional text authored for a PGlite test.',
        $7, 'fixture-normalization-v1', $8, 'unreviewed',
        '{"fixture":"authored-fiction-only"}'::jsonb)`,
    [
      datasetKind, fixture.revisionId, fixture.traceId, fixture.sourceId,
      'https://' + prefix + '.invalid/fixture', TEST_HASH,
      TEST_HASH, TEST_TIME,
    ],
  );
  await database.executor.query(
    `INSERT INTO waspada.extraction_results
       (dataset_kind, candidate_id, trace_id, report_revision_id, category, record_json)
     VALUES ($1, $2, $3, $4, 'transport_road_incidents', '{"fixture":"authored-fiction-only"}'::jsonb)`,
    [datasetKind, fixture.candidateId, fixture.traceId, fixture.revisionId],
  );
  await database.executor.query(
    `INSERT INTO waspada.grounding_contexts
       (dataset_kind, context_id, trace_id, candidate_id, retrieval_version, index_version, sufficient, record_json)
     VALUES ($1, $2, $3, $4, 'fixture-retrieval-v1', 'fixture-index-v1', true,
        '{"fixture":"authored-fiction-only"}'::jsonb)`,
    [datasetKind, fixture.contextId, fixture.traceId, fixture.candidateId],
  );
  return fixture;
}

async function seedGeometry(
  database: TestDatabase,
  fixture: DatasetFixture,
  geometry: GeometrySeed,
): Promise<void> {
  const record = geometry.recordJson ?? makeGeometryRecord(fixture, geometry.geometryId, geometry.geojson);
  expectedGeometryRecords.set(geometry.geometryId, record);
  const type = geometry.geojson.type;
  const role = type === 'LineString' ? 'route_segment' : 'facility';
  await database.executor.query(
    `INSERT INTO waspada.geometries
       (dataset_kind, geometry_id, trace_id, role, shape, coordinate_reference_system,
        precision_basis, display_label, record_json)
     VALUES ($1, $2, $3, $4, ST_SetSRID(ST_GeomFromGeoJSON($5::text), 4326),
        'OGC:CRS84', 'source_supplied', 'Fictional geometry fixture', $6::jsonb)`,
    [fixture.datasetKind, geometry.geometryId, fixture.traceId, role,
      JSON.stringify(geometry.geojson), JSON.stringify(record)],
  );
}

async function seedGeometryBatch(
  database: TestDatabase,
  fixture: DatasetFixture,
  geometryIds: readonly string[],
  longitudes: readonly number[],
): Promise<void> {
  await database.executor.query(
    `INSERT INTO waspada.geometries
       (dataset_kind, geometry_id, trace_id, role, shape, coordinate_reference_system,
        precision_basis, display_label, record_json)
     SELECT 'live', input.geometry_id, $1::text, 'facility',
            ST_SetSRID(ST_MakePoint(input.longitude, -6.2), 4326),
            'OGC:CRS84', 'source_supplied', 'Fictional overflow geometry',
            jsonb_build_object(
              'schema_version', '2.0', 'trace_id', $1::text, 'record_type', 'Geometry',
              'dataset_kind', 'live', 'geometry_id', input.geometry_id,
              'role', 'facility',
              'geojson', jsonb_build_object('type', 'Point',
                'coordinates', jsonb_build_array(input.longitude, -6.2)),
              'coordinate_reference_system', 'OGC:CRS84', 'precision_m', NULL,
              'precision_basis', 'source_supplied', 'display_label', 'Fictional overflow geometry',
              'source_evidence', jsonb_build_array(jsonb_build_object(
                'report_revision_id', $2::text, 'permitted_text_hash', $3::text,
                'span_start', 0, 'span_end', 1, 'offset_unit', 'unicode_code_points', 'relation', 'supports'
              ))
            )
     FROM unnest($4::text[], $5::double precision[]) AS input(geometry_id, longitude)`,
    [fixture.traceId, fixture.revisionId, TEST_HASH, [...geometryIds], [...longitudes]],
  );
}

async function seedFreshnessTransition(
  fixture: DatasetFixture,
  eventId: string,
  eventVersion: number,
): Promise<void> {
  await testDatabase.executor.query(
    `INSERT INTO waspada.freshness_transitions
       (dataset_kind, event_id, event_version, target_kind, transition_sequence,
        previous_status, resulting_status, reason, evaluated_at, trace_id,
        idempotency_key, request_fingerprint)
     VALUES ($1, $2, $3, 'event_claim_set', 1, 'current', 'needs_update',
       'review_deadline_missed', $4, $5, $6, $7)`,
    [
      fixture.datasetKind, eventId, eventVersion, TEST_TIME, fixture.traceId,
      fixture.prefix + ':' + eventId + ':' + eventVersion + ':overlay',
      'f'.repeat(64),
    ],
  );
}


async function seedEventVersion(
  database: TestDatabase,
  fixture: DatasetFixture,
  input: EventSeed,
): Promise<void> {
  const datasetKind = input.datasetKind ?? fixture.datasetKind;
  assert.equal(datasetKind, fixture.datasetKind);
  const status = input.status ?? 'published';
  const eventId = input.eventId;
  const version = input.version;
  const claims = status === 'published'
    ? (input.claims ?? [{ claimId: 'claim-' + eventId, geometryIds: [] }]).map((seed) => ({
      seed,
      record: claimRecord(fixture, seed),
    }))
    : [];
  const decisionId = fixture.prefix + '-decision-' + eventId + '-v' + version;
  const proposalId = fixture.prefix + '-proposal-' + eventId + '-v' + version;
  const record = input.recordJson ?? createEventRecord(fixture, {
    eventId,
    version,
    status,
    category: input.category,
    lifecycle: input.lifecycle,
    freshness: input.freshness,
    impactFreshnessStatuses: input.impactFreshnessStatuses,
    eventGeometryIds: input.eventGeometryIds ?? [],
    claims: claims.map(({ record: claim }) => claim),
    decisionId,
  });

  await database.executor.transaction(async (transaction) => {
    await transaction.execute('SET CONSTRAINTS ALL DEFERRED');
    await transaction.query(
      `INSERT INTO waspada.event_proposals
         (dataset_kind, proposal_id, trace_id, candidate_id, context_id,
          event_id, base_event_version, proposed_at, record_json)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, '{"fixture":"authored-fiction-only"}'::jsonb)`,
      [datasetKind, proposalId, fixture.traceId, fixture.candidateId, fixture.contextId,
        version === 1 ? null : eventId, version === 1 ? null : version - 1, TEST_TIME],
    );
    await transaction.query(
      `INSERT INTO waspada.publication_decisions
         (dataset_kind, decision_id, trace_id, proposal_id, policy_version,
          event_id, event_version, decided_at, record_json)
       VALUES ($1, $2, $3, $4, 'geojson-candidate-fixture-v1', $5, $6, $7,
          '{"fixture":"authored-fiction-only"}'::jsonb)`,
      [datasetKind, decisionId, fixture.traceId, proposalId, eventId, version, TEST_TIME],
    );
    await transaction.query(
      `INSERT INTO waspada.event_versions
         (dataset_kind, event_id, version, trace_id, supersedes_version, title, summary,
          category, lifecycle, publication_status, withdrawal_reason, publication_decision_id,
          published_at, withdrawn_at, record_json)
       VALUES ($1, $2, $3, $4, $5, 'Fictional event fixture',
          'Authored fictional event data for a PGlite candidate test.', $6, $7, $8, $9, $10, $11, $12, $13::jsonb)`,
      [
        datasetKind, eventId, version, fixture.traceId, version === 1 ? null : version - 1,
        input.category ?? 'transport_road_incidents', input.lifecycle ?? 'ongoing', status,
        status === 'withdrawn' ? 'duplicate' : null, decisionId,
        status === 'published' ? TEST_TIME : null,
        status === 'withdrawn' ? TEST_TIME : null,
        JSON.stringify(record),
      ],
    );

    for (const [index, freshnessStatus] of (input.impactFreshnessStatuses ?? []).entries()) {
      const impactId = eventId + '-impact-' + (index + 1);
      await transaction.query(
        `INSERT INTO waspada.impact_versions
           (dataset_kind, impact_id, version, trace_id, event_id, event_version,
            impact_type, lifecycle, published_at, record_json)
         VALUES ($1, $2, 1, $3, $4, $5, 'other', 'ongoing', $6, $7::jsonb)`,
        [datasetKind, impactId, fixture.traceId, eventId, version, TEST_TIME,
          JSON.stringify({ freshness: { status: freshnessStatus } })],
      );
      await transaction.query(
        `INSERT INTO waspada.event_impact_refs
           (dataset_kind, event_id, event_version, impact_id, impact_version)
         VALUES ($1, $2, $3, $4, 1)`,
        [datasetKind, eventId, version, impactId],
      );
    }

    for (const { seed, record: claim } of claims) {
      if (seed.storeClaim !== false) {
        await transaction.query(
          `INSERT INTO waspada.event_claims
             (dataset_kind, event_id, event_version, claim_id, publication_status,
              claim_text, evidence_label, record_json)
           VALUES ($1, $2, $3, $4, 'published', $5, 'issuer_notice', $6::jsonb)`,
          [datasetKind, eventId, version, seed.claimId, 'Fictional claim text for a database test.', JSON.stringify(claim)],
        );
      }
      for (const geometryId of seed.linkedGeometryIds ?? seed.geometryIds) {
        if (seed.storeClaim === false) break;
        await transaction.query(
          `INSERT INTO waspada.event_claim_geometries
             (dataset_kind, event_id, event_version, claim_id, geometry_id)
           VALUES ($1, $2, $3, $4, $5)`,
          [datasetKind, eventId, version, seed.claimId, geometryId],
        );
      }
    }
  });
}

function createEventRecord(
  fixture: DatasetFixture,
  options: {
    readonly eventId: string;
    readonly version: number;
    readonly status?: PublicationStatus;
    readonly category?: string;
    readonly lifecycle?: string;
    readonly freshness?: string;
    readonly impactFreshnessStatuses?: readonly string[];
    readonly eventGeometryIds?: readonly string[];
    readonly claims?: readonly Record<string, unknown>[];
    readonly decisionId?: string;
  },
): Record<string, unknown> {
  const status = options.status ?? 'published';
  return {
    schema_version: '2.0',
    trace_id: fixture.traceId,
    record_type: 'Event',
    dataset_kind: fixture.datasetKind,
    event_id: options.eventId,
    version: options.version,
    supersedes_version: options.version === 1 ? null : options.version - 1,
    title: 'Fictional GeoJSON candidate event',
    summary: 'Authored fictional event content for a database test.',
    category: options.category ?? 'transport_road_incidents',
    tags: [],
    lifecycle: options.lifecycle ?? 'ongoing',
    freshness: {
      status: options.freshness ?? 'current',
      evaluated_at: TEST_TIME,
      review_due_at: null,
      basis: 'unknown',
    },
    event_time: { start: null, end: null, precision: 'unknown' },
    validity: { valid_from: null, valid_until: null },
    scope: {
      place_ids: [], service_ids: [], institution_ids: [], audience_ids: [],
      geometry_ids: [...(options.eventGeometryIds ?? [])],
    },
    claims: status === 'published' ? [...(options.claims ?? [])] : [],
    impact_refs: (options.impactFreshnessStatuses ?? []).map((_, index) => ({
      impact_id: options.eventId + '-impact-' + (index + 1), version: 1,
    })),
    publication_status: status,
    withdrawal_reason: status === 'withdrawn' ? 'duplicate' : null,
    publication_decision_id: options.decisionId ?? 'fixture-event-decision',
    published_at: status === 'published' ? TEST_TIME : null,
    withdrawn_at: status === 'withdrawn' ? TEST_TIME : null,
  };
}

function claimRecord(fixture: DatasetFixture, seed: ClaimSeed): Record<string, unknown> {
  return {
    claim_id: seed.claimId,
    text: 'Fictional claim text for a database test.',
    event_time: { start: null, end: null, precision: 'unknown' },
    validity: { valid_from: null, valid_until: null },
    scope: {
      place_ids: [], service_ids: [], institution_ids: [], audience_ids: [],
      geometry_ids: [...seed.geometryIds],
    },
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

function makeGeometryRecord(
  fixture: DatasetFixture,
  geometryId: string,
  geojson: Record<string, unknown>,
): Record<string, unknown> {
  return {
    schema_version: '2.0',
    trace_id: fixture.traceId,
    record_type: 'Geometry',
    dataset_kind: fixture.datasetKind,
    geometry_id: geometryId,
    role: geojson.type === 'LineString' ? 'route_segment' : 'facility',
    geojson,
    coordinate_reference_system: 'OGC:CRS84',
    precision_m: null,
    precision_basis: 'source_supplied',
    display_label: 'Fictional geometry fixture',
    source_evidence: [{
      report_revision_id: fixture.revisionId,
      permitted_text_hash: TEST_HASH,
      span_start: 0,
      span_end: 1,
      offset_unit: 'unicode_code_points',
      relation: 'supports',
    }],
  };
}

function makeFakeCandidate(
  eventId: string,
  eventVersion: number,
  geometryId: string,
): Record<string, unknown> & {
  readonly event_record_json: Record<string, unknown>;
  readonly geometry_record_json: Record<string, unknown>;
} {
  return {
    dataset_kind: 'live',
    event_id: eventId,
    event_version: eventVersion,
    category: 'transport_road_incidents',
    lifecycle: 'ongoing',
    freshness: 'current',
    geometry_id: geometryId,
    event_record_json: {
      schema_version: '2.0', record_type: 'Event', dataset_kind: 'live', event_id: eventId,
      version: eventVersion, publication_status: 'published', category: 'transport_road_incidents',
      lifecycle: 'ongoing', freshness: { status: 'current' }, claims: [],
    },
    geometry_record_json: {
      schema_version: '2.0', record_type: 'Geometry', dataset_kind: 'live', geometry_id: geometryId,
    },
  };
}

function fixedRowsExecutor(rows: readonly Record<string, unknown>[]): SqlExecutor {
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
    async execute(statement: string) {
      await executor.execute(statement);
    },
  };
}
