import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import {
  createSourceRevisionFreshnessTargetReader,
  SourceRevisionFreshnessTargetReaderError,
  type FreshnessTargetIdentity,
  type SourceRevisionFreshnessTarget,
} from '../src/source-revision-freshness-target-reader.js';
import { applyMigrations, readMigrations } from '../src/migrations.js';
import type { SqlExecutor } from '../src/sql.js';
import { createTestDatabase, type TestDatabase } from './harness.js';

const LIVE = 'live' as const;
const TRACE_ID = 'trace-freshness-target-live';
const NOW = '2026-10-04T10:00:00.000000Z';
const EVENT_VALID_UNTIL = '2026-10-05T10:00:00+07:00';
const IMPACT_VALID_UNTIL = '2026-10-04T10:00:00+07:00';
const PRIVATE_SOURCE_TEXT = 'PRIVATE_SOURCE_TEXT authored fixture only.';
const PRIVATE_EVENT_TEXT = 'PRIVATE_EVENT_TEXT authored fixture only.';
const PRIVATE_IMPACT_TEXT = 'PRIVATE_IMPACT_TEXT authored fixture only.';

// The `live` dataset below is an isolated authored PGlite fixture namespace, not live/public data.

let database!: TestDatabase;
let reader!: ReturnType<typeof createSourceRevisionFreshnessTargetReader>;
let recoveryEvidenceId!: string;

describe('LIFE-01 source-revision freshness target reader', () => {
  before(async () => {
    database = await createTestDatabase();
    const migrations = await readMigrations(new URL('../migrations/', import.meta.url));
    await applyMigrations(database.executor, migrations);
    reader = createSourceRevisionFreshnessTargetReader(database.executor);
    recoveryEvidenceId = await seedSharedFixtureRows(database);
    await seedEvents(database, recoveryEvidenceId);
  });

  after(async () => database?.close());

  it('returns effective exact target state, never the event aggregate or unreferenced versions', async () => {
    const requestTargets = [
      eventTarget('event-aggregate', 1),
      impactTarget('event-aggregate', 1, 'impact-aggregate', 1),
      impactTarget('event-aggregate', 1, 'impact-fallback', 1),
      eventTarget('event-transition', 1),
      eventTarget('event-versioned', 1),
      eventTarget('event-versioned', 2),
      eventTarget('event-withdrawn', 1),
      eventTarget('event-withdrawn', 2),
      eventTarget('missing-event', 1),
      eventTarget('event-aggregate', 2),
      impactTarget('event-aggregate', 1, 'impact-aggregate', 2),
      impactTarget('event-aggregate', 1, 'impact-aggregate-unreferenced', 1),
      eventTarget('event-aggregate', 1),
      { target: { kind: 'event_claim_set' as const }, eventVersion: 1, eventId: 'event-aggregate' },
    ];
    const targets = await reader.read({ datasetKind: LIVE, targets: requestTargets });

    const claimSet = findTarget(targets, 'event-aggregate', 'event_claim_set');
    assert.ok(claimSet);
    assert.equal(claimSet.status, 'current');
    assert.equal(claimSet.transitionSequence, 0);
    assert.equal(claimSet.validUntil, EVENT_VALID_UNTIL);

    const aggregate = await database.executor.query<{ freshness_status: string; record_json: { freshness: { status: string } } }>(
      `SELECT freshness_status, record_json
       FROM waspada.public_event_versions
       WHERE dataset_kind = 'live' AND event_id = 'event-aggregate' AND version = 1`,
    );
    assert.equal(aggregate.rows[0]?.freshness_status, 'needs_update',
      'the impact expiry makes the public event aggregate stale');
    assert.equal(aggregate.rows[0]?.record_json.freshness.status, 'needs_update');
    assert.equal(claimSet.status, 'current',
      'event claim-set status comes from the immutable event record and its exact transition');

    const eventTransition = findTarget(targets, 'event-transition', 'event_claim_set');
    assert.ok(eventTransition);
    assert.equal(eventTransition.status, 'needs_update');
    assert.equal(eventTransition.transitionSequence, 2,
      'the latest transition sequence wins over both the earlier transition and base status');

    const impact = findTarget(targets, 'event-aggregate', 'impact', 'impact-aggregate', 2);
    assert.ok(impact);
    assert.equal(impact.status, 'expired');
    assert.equal(impact.transitionSequence, 2);
    assert.equal(impact.validUntil, IMPACT_VALID_UNTIL,
      'the issuer validity end is returned exactly, including its offset');

    const fallbackImpact = findTarget(targets, 'event-aggregate', 'impact', 'impact-fallback', 1);
    assert.ok(fallbackImpact);
    assert.equal(fallbackImpact.status, 'needs_update');
    assert.equal(fallbackImpact.transitionSequence, 0,
      'an impact without a transition falls back to its immutable impact record');
    assert.equal(fallbackImpact.validUntil, null);

    const currentVersion = findTarget(targets, 'event-versioned', 'event_claim_set');
    assert.ok(currentVersion);
    assert.equal(currentVersion.eventVersion, 2);
    assert.equal(currentVersion.status, 'current');
    assert.equal(currentVersion.transitionSequence, 0,
      'a prior-version transition cannot affect the latest event version');
    assert.equal(findTarget(targets, 'event-versioned', 'event_claim_set', undefined, undefined, 1), undefined);
    assert.equal(findTarget(targets, 'event-withdrawn', 'event_claim_set'), undefined,
      'the older published version is hidden by the latest withdrawn version');
    assert.equal(targets.some(({ eventId }) => eventId === 'event-withdrawn'), false);
    assert.equal(targets.some(({ target }) =>
      target.kind === 'impact' && target.impactId === 'impact-aggregate-unreferenced'), false);
    assert.equal(targets.some(({ target }) =>
      target.kind === 'impact' && target.impactId === 'impact-aggregate' && target.impactVersion === 1), false,
    'an existing but unreferenced impact version is excluded');
    assert.equal(targets.length, new Set(targets.map(targetKey)).size,
      'repeated input identities yield one result');

    const serialized = JSON.stringify(targets);
    for (const privateValue of [
      PRIVATE_SOURCE_TEXT, PRIVATE_EVENT_TEXT, PRIVATE_IMPACT_TEXT,
      'canonical_url', 'traceId', 'sourceId', 'record_json', 'claims', 'description',
    ]) {
      assert.equal(serialized.includes(privateValue), false, `reader output omits ${privateValue}`);
    }
    for (const target of targets) {
      assert.deepEqual(Object.keys(target).sort(), [
        'eventId', 'eventVersion', 'status', 'target', 'transitionSequence', 'validUntil',
      ].sort());
      assert.deepEqual(Object.keys(target.target).sort(), target.target.kind === 'impact'
        ? ['impactId', 'impactVersion', 'kind']
        : ['kind']);
    }
  });

  it('deduplicates before one bounded parameterized SQL read and returns deterministic key order', async () => {
    let queryCalls = 0;
    let executeCalls = 0;
    let capturedStatement = '';
    let capturedParameters: readonly unknown[] = [];
    const trackedExecutor: SqlExecutor = {
      async query<Row extends object>(statement: string, parameters: readonly unknown[] = []) {
        queryCalls += 1;
        capturedStatement = statement;
        capturedParameters = parameters;
        return database.executor.query<Row>(statement, parameters);
      },
      async execute() {
        executeCalls += 1;
        throw new Error('The read-only repository must not execute writes.');
      },
    };
    const trackedReader = createSourceRevisionFreshnessTargetReader(trackedExecutor);

    const result = await trackedReader.read({
      datasetKind: LIVE,
      targets: [
        eventTarget('z-event', 1),
        impactTarget('event-aggregate', 1, 'impact-aggregate', 2),
        eventTarget('event-aggregate', 1),
        eventTarget('event-aggregate', 1),
      ],
    });

    assert.equal(queryCalls, 1);
    assert.equal(executeCalls, 0);
    assert.equal(capturedParameters.length, 1);
    assert.equal(JSON.parse(String(capturedParameters[0])).length, 3,
      'the SQL input contains unique identities only');
    assert.match(capturedStatement, /jsonb_to_recordset\(\$1::jsonb\)/u);
    assert.match(capturedStatement, /LIMIT \(SELECT count\(\*\) FROM requested_targets\)/su);
    assert.doesNotMatch(capturedStatement, /public_event_versions|report_revision_source_observations|report_revisions/u);
    assert.deepEqual(result.map(targetKey), [
      'event-aggregate:event_claim_set',
      'event-aggregate:impact:impact-aggregate:2',
      'z-event:event_claim_set',
    ]);
    assert.equal(result.length <= 3, true);
  });

  it('rejects synthetic and historical datasets and oversized or malformed requests before SQL', async () => {
    let calls = 0;
    const noQueryReader = createSourceRevisionFreshnessTargetReader({
      async query<Row extends object>() {
        calls += 1;
        return { rows: [] as Row[] };
      },
      async execute() {},
    });
    const validTarget = eventTarget('safe-event', 1);
    for (const request of [
      { targets: [validTarget] },
      { datasetKind: 'synthetic', targets: [validTarget] },
      { datasetKind: 'historical', targets: [validTarget] },
      { datasetKind: 'unknown', targets: [validTarget] },
      { datasetKind: LIVE, targets: [] },
      { datasetKind: LIVE, targets: Array.from({ length: 101 }, () => validTarget) },
      { datasetKind: LIVE, extra: true, targets: [validTarget] },
      { datasetKind: LIVE, targets: [{ ...validTarget, extra: 'PRIVATE_BAD_ID' }] },
      { datasetKind: LIVE, targets: [eventTarget('', 1)] },
      { datasetKind: LIVE, targets: [eventTarget('safe-event', 0)] },
      { datasetKind: LIVE, targets: [{ ...validTarget, target: { kind: 'event_claim_set', extra: true } }] },
      { datasetKind: LIVE, targets: [impactTarget('safe-event', 1, 'impact', 2.5)] },
      { datasetKind: LIVE, targets: [{
        eventId: 'safe-event', eventVersion: 1,
        target: { kind: 'impact', impactId: 'bad/id', impactVersion: 1 },
      }] },
    ]) {
      await expectReaderError(noQueryReader.read(request), 'INVALID_REQUEST');
    }
    assert.equal(calls, 0, 'bad dataset and request size are rejected before SQL');
  });

  it('validates database result shape, requested identity, order, and content-free errors', async () => {
    const request = { datasetKind: LIVE, targets: [eventTarget('requested-event', 1)] };
    const validRow = rawTargetRow();
    for (const rows of [
      [{ ...validRow, source_text: PRIVATE_SOURCE_TEXT }],
      [{ ...validRow, event_id: 'unrequested-secret-id' }],
      [validRow, validRow],
      [{ ...validRow, status: 'fresh-ish' }],
      [{ ...validRow, transition_sequence: -1 }],
      [{ ...validRow, valid_until: '2026-02-30T10:00:00Z' }],
      [{ ...validRow, dataset_kind: 'synthetic' }],
      [
        rawTargetRow({ event_id: 'requested-z', target_kind: 'event_claim_set' }),
        rawTargetRow({ event_id: 'requested-a', target_kind: 'event_claim_set' }),
      ],
    ]) {
      const malformedReader = readerForRows(rows);
      await assert.rejects(malformedReader.read({
        datasetKind: LIVE,
        targets: rows.length === 2
          ? [eventTarget('requested-z', 1), eventTarget('requested-a', 1)]
          : request.targets,
      }), (error: unknown) => error instanceof SourceRevisionFreshnessTargetReaderError
        && error.code === 'INVALID_RESULT'
        && error.message === 'The source-revision freshness target result could not be validated.'
        && !error.message.includes('PRIVATE_SOURCE_TEXT')
        && !error.message.includes('unrequested-secret-id'));
    }

    const failedReader = createSourceRevisionFreshnessTargetReader({
      async query() { throw new Error(`database secret ${PRIVATE_SOURCE_TEXT}`); },
      async execute() {},
    });
    await assert.rejects(failedReader.read(request), (error: unknown) =>
      error instanceof SourceRevisionFreshnessTargetReaderError
      && error.code === 'READ_FAILED'
      && error.message === 'The source-revision freshness targets could not be read.'
      && !error.message.includes(PRIVATE_SOURCE_TEXT));
  });

  it('uses only existing freshness-writer reads and leaves every stored/public row unchanged', async () => {
    const before = await databaseSnapshot(database);
    const allowedTargets = [
      eventTarget('event-aggregate', 1),
      impactTarget('event-aggregate', 1, 'impact-aggregate', 2),
      eventTarget('event-transition', 1),
    ];

    await database.executor.execute('SET ROLE waspada_l4_freshness_writer');
    try {
      const allowed = await reader.read({ datasetKind: LIVE, targets: allowedTargets });
      assert.equal(allowed.length, 3);

      for (const query of [
        'SELECT * FROM waspada.report_revision_source_observations',
        'SELECT * FROM waspada.report_revisions',
        'SELECT * FROM waspada.publication_decisions',
        'SELECT * FROM waspada.publication_outbox',
      ]) {
        await assert.rejects(database.executor.query(query), /permission denied/i,
          'freshness writer has no source-observation or unrelated content reads');
      }
      for (const statement of [
        "UPDATE waspada.event_versions SET lifecycle = 'resolved' WHERE event_id = 'event-aggregate'",
        "UPDATE waspada.impact_versions SET lifecycle = 'resolved' WHERE impact_id = 'impact-aggregate'",
        "UPDATE waspada.freshness_transitions SET resulting_status = 'current' WHERE event_id = 'event-transition'",
        `INSERT INTO waspada.report_revision_source_observations
           (dataset_kind, observation_id, trace_id, source_id, target_report_revision_id,
            assertion_report_revision_id, asserted_state, retrieved_at)
         VALUES ('live', 'unauthorized-observation', '${TRACE_ID}', 'source-freshness-target',
                 'revision-target', 'revision-notice', 'retracted', '${NOW}')`,
        "INSERT INTO waspada.publication_outbox (outbox_id, dataset_kind, event_id, event_version, event_kind, trace_id, occurred_at) VALUES ('unauthorized-outbox', 'live', 'event-aggregate', 1, 'event_version_published', 'trace-freshness-target-live', '2026-10-04T10:00:00Z')",
      ]) {
        await assert.rejects(database.executor.query(statement), /permission denied/i,
          'freshness writer cannot mutate publication, source-observation, or base rows');
      }
    } finally {
      await database.executor.execute('RESET ROLE');
    }

    for (const role of [
      'waspada_public_reader', 'waspada_l1_pipeline', 'waspada_l2_grounding_reader',
      'waspada_l2_grounding_writer', 'waspada_l2_proposal_writer',
    ]) {
      await database.executor.execute(`SET ROLE ${role}`);
      try {
        await assert.rejects(reader.read({ datasetKind: LIVE, targets: allowedTargets }),
          (error: unknown) => error instanceof SourceRevisionFreshnessTargetReaderError
            && error.code === 'READ_FAILED',
          `${role} does not gain access to the private freshness target query`);
        await assert.rejects(database.executor.query('SELECT * FROM waspada.freshness_transitions'),
          /permission denied/i, `${role} cannot read the private transition ledger`);
      } finally {
        await database.executor.execute('RESET ROLE');
      }
    }

    await database.executor.execute('SET ROLE waspada_public_reader');
    try {
      const publicRead = await database.executor.query(
        "SELECT event_id FROM waspada.public_event_versions WHERE dataset_kind = 'live' AND event_id = 'event-aggregate'",
      );
      assert.equal(publicRead.rows.length, 1, 'the existing public safe-view capability still works');
    } finally {
      await database.executor.execute('RESET ROLE');
    }

    assert.deepEqual(await databaseSnapshot(database), before,
      'all database table rows and current public/history projections remain unchanged');
  });
});

function eventTarget(eventId: string, eventVersion: number) {
  return { eventId, eventVersion, target: { kind: 'event_claim_set' as const } };
}

function impactTarget(eventId: string, eventVersion: number, impactId: string, impactVersion: number) {
  return { eventId, eventVersion, target: { kind: 'impact' as const, impactId, impactVersion } };
}

function findTarget(
  targets: readonly SourceRevisionFreshnessTarget[],
  eventId: string,
  kind: FreshnessTargetIdentity['kind'],
  impactId?: string,
  impactVersion?: number,
  eventVersion?: number,
): SourceRevisionFreshnessTarget | undefined {
  return targets.find((target) => target.eventId === eventId
    && (eventVersion === undefined || target.eventVersion === eventVersion)
    && target.target.kind === kind
    && (kind !== 'impact' || (target.target.kind === 'impact'
      && target.target.impactId === impactId
      && (impactVersion === undefined || target.target.impactVersion === impactVersion))));
}

function targetKey(target: SourceRevisionFreshnessTarget): string {
  return target.target.kind === 'event_claim_set'
    ? `${target.eventId}:event_claim_set`
    : `${target.eventId}:impact:${target.target.impactId}:${target.target.impactVersion}`;
}

function rawTargetRow(overrides: Record<string, unknown> = {}) {
  return {
    dataset_kind: LIVE,
    event_id: 'requested-event',
    event_version: 1,
    target_kind: 'event_claim_set',
    impact_id: null,
    impact_version: null,
    status: 'current',
    transition_sequence: 0,
    valid_until: EVENT_VALID_UNTIL,
    ...overrides,
  };
}

function readerForRows(rows: readonly unknown[]) {
  return createSourceRevisionFreshnessTargetReader({
    async query<Row extends object>() {
      return { rows: rows as Row[] };
    },
    async execute() {},
  });
}

async function expectReaderError(promise: Promise<unknown>, code: 'INVALID_REQUEST' | 'INVALID_RESULT' | 'READ_FAILED') {
  await assert.rejects(promise, (error: unknown) => error instanceof SourceRevisionFreshnessTargetReaderError
    && error.code === code
    && !error.message.includes('PRIVATE_BAD_ID'));
}

async function seedSharedFixtureRows(database: TestDatabase): Promise<string> {
  await database.executor.query(
    `INSERT INTO waspada.dataset_namespace_config (singleton, dataset_kind, configured_at)
     VALUES (true, 'live', $1)
     ON CONFLICT (singleton) DO UPDATE SET dataset_kind = EXCLUDED.dataset_kind,
       configured_at = EXCLUDED.configured_at`,
    [NOW],
  );
  await database.executor.query(
    `INSERT INTO waspada.traces (trace_id, dataset_kind, started_at, ended_at, outcome, metadata)
     VALUES ($1, 'live', $2, $2, 'succeeded', '{"fixture":"authored-only"}'::jsonb)`,
    [TRACE_ID, NOW],
  );
  await database.executor.query(
    `INSERT INTO waspada.source_registry
       (source_id, trace_id, registry_version, display_name, source_kind, remit, access_method,
        approved_hosts, access_restrictions, reuse_basis, registry_status, approval_status,
        health_status, auto_acquisition_enabled, auto_publication_policy)
     VALUES ('source-freshness-target', $1, 1, 'Authored test fixture', 'other', ARRAY['test'],
       'manual_fixture', ARRAY[]::text[], ARRAY['fixture only'], ARRAY['authored data'],
       'active', 'pending', 'unknown', false, 'never')`,
    [TRACE_ID],
  );

  const reportText = 'Authored private source revision fixture.';
  const reportHash = hash(reportText);
  const contentHash = hash(`content:${reportText}`);
  for (const revisionId of ['revision-target', 'revision-notice']) {
    await database.executor.query(
      `INSERT INTO waspada.report_revisions
         (dataset_kind, report_revision_id, trace_id, source_id, canonical_url, content_hash,
          permitted_text, permitted_text_hash, normalization_version, retrieved_at,
          revision_status, record_json)
       VALUES ('live', $1, $2, 'source-freshness-target', 'https://fixture.invalid/private',
         $3, $4, $5, 'fixture-normalization-v1', $6, 'eligible', '{"fixture":"private"}'::jsonb)`,
      [revisionId, TRACE_ID, contentHash, reportText, reportHash, NOW],
    );
  }
  await database.executor.query(
    `INSERT INTO waspada.evidence_references
       (dataset_kind, trace_id, report_revision_id, permitted_text_hash, span_start, span_end,
        offset_unit, relation)
     VALUES ('live', $1, 'revision-target', $2, 0, 8, 'unicode_code_points', 'supports')`,
    [TRACE_ID, reportHash],
  );
  const evidenceResult = await database.executor.query<{ evidence_ref_id: string }>(
    `SELECT evidence_ref_id::text AS evidence_ref_id
     FROM waspada.evidence_references WHERE dataset_kind = 'live' AND report_revision_id = 'revision-target'`,
  );
  await database.executor.query(
    `INSERT INTO waspada.report_revision_source_observations
       (dataset_kind, observation_id, trace_id, source_id, target_report_revision_id,
        assertion_report_revision_id, asserted_state, retrieved_at)
     VALUES ('live', 'observation-private-fixture', $1, 'source-freshness-target',
       'revision-target', 'revision-notice', 'retracted', $2)`,
    [TRACE_ID, NOW],
  );

  await database.executor.query(
    `INSERT INTO waspada.extraction_results
       (dataset_kind, candidate_id, trace_id, report_revision_id, category, record_json)
     VALUES ('live', 'candidate-freshness-target', $1, 'revision-target', NULL, '{"fixture":"only"}'::jsonb)`,
    [TRACE_ID],
  );
  await database.executor.query(
    `INSERT INTO waspada.grounding_contexts
       (dataset_kind, context_id, trace_id, candidate_id, retrieval_version, index_version, sufficient, record_json)
     VALUES ('live', 'context-freshness-target', $1, 'candidate-freshness-target',
       'fixture-retrieval-v1', 'fixture-index-v1', false, '{"fixture":"only"}'::jsonb)`,
    [TRACE_ID],
  );
  await database.executor.query(
    `INSERT INTO waspada.event_proposals
       (dataset_kind, proposal_id, trace_id, candidate_id, context_id, proposed_at, record_json)
     VALUES ('live', 'proposal-freshness-target', $1, 'candidate-freshness-target',
       'context-freshness-target', $2, '{"fixture":"only"}'::jsonb)`,
    [TRACE_ID, NOW],
  );

  return evidenceResult.rows[0]!.evidence_ref_id;
}

async function seedEvents(database: TestDatabase, evidenceReferenceId: string): Promise<void> {
  await seedEventVersion(database, 'event-aggregate', 1, {
    status: 'current',
    validUntil: EVENT_VALID_UNTIL,
    impacts: [
      { impactId: 'impact-aggregate', impactVersion: 2 },
      { impactId: 'impact-fallback', impactVersion: 1 },
    ],
  });
  await seedImpactVersion(database, 'event-aggregate', 1, 'impact-aggregate', 1, {
    status: 'current', validUntil: null,
  });
  await seedImpactVersion(database, 'event-aggregate', 1, 'impact-aggregate', 2, {
    status: 'current', validUntil: IMPACT_VALID_UNTIL,
  });
  await seedEventImpactReference(database, 'event-aggregate', 1, 'impact-aggregate', 2);
  await seedImpactVersion(database, 'event-aggregate', 1, 'impact-fallback', 1, {
    status: 'needs_update', validUntil: null,
  });
  await seedEventImpactReference(database, 'event-aggregate', 1, 'impact-fallback', 1);
  await insertTransitions(database, [
    {
      eventId: 'event-aggregate', eventVersion: 1, targetKind: 'impact',
      impactId: 'impact-aggregate', impactVersion: 2,
      sequence: 1, previousStatus: 'current', resultingStatus: 'needs_update',
      reason: 'review_deadline_missed',
    },
    {
      eventId: 'event-aggregate', eventVersion: 1, targetKind: 'impact',
      impactId: 'impact-aggregate', impactVersion: 2,
      sequence: 2, previousStatus: 'needs_update', resultingStatus: 'expired',
      reason: 'issuer_validity_ended',
    },
  ]);
  await seedImpactVersion(database, 'event-aggregate', 1, 'impact-aggregate-unreferenced', 1, {
    status: 'needs_update', validUntil: null,
  });

  await seedEventVersion(database, 'event-transition', 1, { status: 'expired' });
  await insertTransitions(database, [
    {
      eventId: 'event-transition', eventVersion: 1, targetKind: 'event_claim_set', sequence: 1,
      previousStatus: 'expired', resultingStatus: 'current', reason: 'new_applicable_evidence_evaluated',
      evidenceReferenceId,
    },
    {
      eventId: 'event-transition', eventVersion: 1, targetKind: 'event_claim_set', sequence: 2,
      previousStatus: 'current', resultingStatus: 'needs_update', reason: 'review_deadline_missed',
    },
  ]);

  await seedEventVersion(database, 'event-versioned', 1, { status: 'expired' });
  await insertTransitions(database, [{
    eventId: 'event-versioned', eventVersion: 1, targetKind: 'event_claim_set', sequence: 1,
    previousStatus: 'expired', resultingStatus: 'current', reason: 'new_applicable_evidence_evaluated',
    evidenceReferenceId,
  }]);
  await seedEventVersion(database, 'event-versioned', 2, { status: 'current' });

  await seedEventVersion(database, 'event-withdrawn', 1, { status: 'current' });
  await seedEventVersion(database, 'event-withdrawn', 2, {
    publicationStatus: 'withdrawn', status: 'expired',
  });

  await seedEventVersion(database, 'a-event', 1, { status: 'current' });
  await seedEventVersion(database, 'z-event', 1, { status: 'current' });
}

interface EventFixture {
  readonly publicationStatus?: 'published' | 'withdrawn';
  readonly status?: 'current' | 'needs_update' | 'expired';
  readonly validUntil?: string | null;
  readonly impacts?: readonly { readonly impactId: string; readonly impactVersion: number }[];
}

async function seedEventVersion(
  database: TestDatabase,
  eventId: string,
  version: number,
  fixture: EventFixture,
): Promise<void> {
  const publicationStatus = fixture.publicationStatus ?? 'published';
  const withdrawn = publicationStatus === 'withdrawn';
  const decisionId = `decision-${eventId}-${version}`;
  const impactRefs = withdrawn ? [] : (fixture.impacts ?? []).map(({ impactId, impactVersion }) => ({
    impact_id: impactId,
    version: impactVersion,
  }));
  const claims = withdrawn ? [] : [{ claim_id: `claim-${eventId}-${version}`, text: PRIVATE_EVENT_TEXT }];
  const record = {
    schema_version: '2.0',
    trace_id: TRACE_ID,
    record_type: 'Event',
    dataset_kind: LIVE,
    event_id: eventId,
    version,
    supersedes_version: version === 1 ? null : version - 1,
    title: 'Authored freshness target fixture',
    summary: PRIVATE_EVENT_TEXT,
    category: 'group_specific_critical_notices',
    tags: [],
    lifecycle: 'unknown',
    freshness: { status: fixture.status ?? 'current', evaluated_at: NOW, review_due_at: null, basis: 'manual_review' },
    event_time: { start: null, end: null, precision: 'unknown' },
    validity: { valid_from: null, valid_until: fixture.validUntil ?? null },
    scope: { place_ids: [], service_ids: [], institution_ids: [], audience_ids: [], geometry_ids: [] },
    claims,
    impact_refs: impactRefs,
    publication_status: publicationStatus,
    withdrawal_reason: withdrawn ? 'other' : null,
    publication_decision_id: decisionId,
    published_at: withdrawn ? null : NOW,
    withdrawn_at: withdrawn ? NOW : null,
  };

  await database.executor.transaction(async (transaction) => {
    await transaction.query(
      `INSERT INTO waspada.publication_decisions
         (dataset_kind, decision_id, trace_id, proposal_id, policy_version, event_id,
          event_version, decided_at, record_json)
       VALUES ('live', $1, $2, 'proposal-freshness-target', 'fixture-policy-v1', $3, $4, $5,
         '{"fixture":"authored-only"}'::jsonb)`,
      [decisionId, TRACE_ID, eventId, version, NOW],
    );
    await transaction.query(
      `INSERT INTO waspada.event_versions
         (dataset_kind, event_id, version, trace_id, supersedes_version, title, summary, category,
          lifecycle, publication_status, withdrawal_reason, publication_decision_id,
          published_at, withdrawn_at, record_json)
       VALUES ('live', $1, $2, $3, $4, 'Authored freshness target fixture', $5,
         'group_specific_critical_notices', 'unknown', $6, $7, $8, $9, $10, $11::jsonb)`,
      [eventId, version, TRACE_ID, version === 1 ? null : version - 1, PRIVATE_EVENT_TEXT,
        publicationStatus, withdrawn ? 'other' : null, decisionId,
        withdrawn ? null : NOW, withdrawn ? NOW : null, JSON.stringify(record)],
    );
  });
}

async function seedImpactVersion(
  database: TestDatabase,
  eventId: string,
  eventVersion: number,
  impactId: string,
  impactVersion: number,
  fixture: { readonly status: 'current' | 'needs_update' | 'expired'; readonly validUntil: string | null },
): Promise<void> {
  const record = {
    schema_version: '2.0',
    trace_id: TRACE_ID,
    record_type: 'Impact',
    dataset_kind: LIVE,
    impact_id: impactId,
    version: impactVersion,
    event_id: eventId,
    event_version: eventVersion,
    impact_type: 'road_closure',
    title: 'Authored freshness impact fixture',
    description: PRIVATE_IMPACT_TEXT,
    lifecycle: 'unknown',
    freshness: { status: fixture.status, evaluated_at: NOW, review_due_at: null, basis: 'manual_review' },
    event_time: { start: null, end: null, precision: 'unknown' },
    validity: { valid_from: null, valid_until: fixture.validUntil },
    scope: { place_ids: [], service_ids: [], institution_ids: [], audience_ids: [], geometry_ids: [] },
    supporting_claim_ids: [],
    published_at: NOW,
  };
  await database.executor.query(
    `INSERT INTO waspada.impact_versions
       (dataset_kind, impact_id, version, trace_id, event_id, event_version,
        impact_type, lifecycle, published_at, record_json)
     VALUES ('live', $1, $2, $3, $4, $5, 'road_closure', 'unknown', $6, $7::jsonb)`,
    [impactId, impactVersion, TRACE_ID, eventId, eventVersion, NOW, JSON.stringify(record)],
  );
}

async function seedEventImpactReference(
  database: TestDatabase,
  eventId: string,
  eventVersion: number,
  impactId: string,
  impactVersion: number,
): Promise<void> {
  await database.executor.query(
    `INSERT INTO waspada.event_impact_refs
       (dataset_kind, event_id, event_version, impact_id, impact_version)
     VALUES ('live', $1, $2, $3, $4)`,
    [eventId, eventVersion, impactId, impactVersion],
  );
}

interface TransitionFixture {
  readonly eventId: string;
  readonly eventVersion: number;
  readonly targetKind: 'event_claim_set' | 'impact';
  readonly impactId?: string;
  readonly impactVersion?: number;
  readonly sequence: number;
  readonly previousStatus: 'current' | 'needs_update' | 'expired';
  readonly resultingStatus: 'current' | 'needs_update' | 'expired';
  readonly reason: 'issuer_validity_ended' | 'new_applicable_evidence_evaluated' | 'review_deadline_missed';
  readonly evidenceReferenceId?: string;
}

async function insertTransitions(database: TestDatabase, fixtures: readonly TransitionFixture[]): Promise<void> {
  await database.executor.transaction(async (transaction) => {
    for (const fixture of fixtures) {
      const inserted = await transaction.query<{ transition_id: string }>(
        `INSERT INTO waspada.freshness_transitions
           (dataset_kind, event_id, event_version, target_kind, impact_id, impact_version,
            transition_sequence, previous_status, resulting_status, reason, evaluated_at,
            trace_id, idempotency_key, request_fingerprint)
         VALUES ('live', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
         RETURNING transition_id::text AS transition_id`,
        [fixture.eventId, fixture.eventVersion, fixture.targetKind,
          fixture.targetKind === 'impact' ? fixture.impactId : null,
          fixture.targetKind === 'impact' ? fixture.impactVersion : null,
          fixture.sequence, fixture.previousStatus, fixture.resultingStatus, fixture.reason,
          NOW, TRACE_ID, `freshness-target:${fixture.eventId}:${fixture.targetKind}:${fixture.sequence}`,
          hash(`freshness-target:${fixture.eventId}:${fixture.targetKind}:${fixture.sequence}`)],
      );
      if (fixture.evidenceReferenceId !== undefined) {
        await transaction.query(
          `INSERT INTO waspada.freshness_transition_evidence
             (transition_id, dataset_kind, evidence_ref_id)
           VALUES ($1::bigint, 'live', $2::bigint)`,
          [inserted.rows[0]!.transition_id, fixture.evidenceReferenceId],
        );
      }
    }
  });
}

async function databaseSnapshot(database: TestDatabase): Promise<unknown> {
  const tables = await database.executor.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'waspada' AND table_type = 'BASE TABLE'
     ORDER BY table_name COLLATE "C"`,
  );
  const storedRows: Record<string, unknown> = {};
  for (const { table_name: tableName } of tables.rows) {
    const identifier = `"${tableName.replaceAll('"', '""')}"`;
    const snapshot = await database.executor.query<{ rows: unknown }>(
      `SELECT COALESCE(
         jsonb_agg(to_jsonb(snapshot_row) ORDER BY to_jsonb(snapshot_row)::text),
         '[]'::jsonb
       ) AS rows
       FROM waspada.${identifier} AS snapshot_row`,
    );
    storedRows[tableName] = snapshot.rows[0]?.rows ?? [];
  }

  const publicViews: Record<string, unknown> = {};
  for (const view of [
    'public_event_versions', 'public_event_impacts', 'public_event_history_versions',
  ]) {
    const result = await database.executor.query(
      `SELECT to_jsonb(public_row) AS row
       FROM waspada.${view} AS public_row
       ORDER BY to_jsonb(public_row)::text`,
    );
    publicViews[view] = result.rows;
  }
  return { storedRows, publicViews };
}

function hash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
