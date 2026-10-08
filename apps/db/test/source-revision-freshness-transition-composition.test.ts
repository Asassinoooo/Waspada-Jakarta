import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import type {
  AppendSourceRevisionFreshnessTransitionInput,
} from '../src/freshness-transition-ledger.js';
import {
  createSqlFreshnessTransitionLedger,
} from '../src/freshness-transition-ledger.js';
import { createSourceRevisionFreshnessTargetReader } from '../src/source-revision-freshness-target-reader.js';
import { createSourceRevisionReviewCandidateReader } from '../src/source-revision-review-candidate-reader.js';
import { applyMigrations, readMigrations } from '../src/migrations.js';
import { createTestDatabase, type TestDatabase } from './harness.js';
import { createSourceRevisionFreshnessTransitionCoordinator } from '../../worker/src/layers/l4-application-integration/source-revision-freshness-transition.js';
import {
  handlePublicApiRequest,
  type WorkerEnvironment,
} from '../../worker/src/layers/l4-application-integration/api.js';
import type { EventDetail, EventPage, EventView, PublicFeatureCollection } from '../../worker/src/contracts/public-api.js';
import type { TelemetryRecord } from '../../worker/src/layers/l5-evaluation-monitoring/telemetry.js';
import { createPublicEventUpdatesCursorCodec } from '../../worker/src/layers/l4-application-integration/public-event-updates-cursor.js';
import type { PublicEventUpdatesPage } from '../../worker/src/layers/l4-application-integration/public-event-updates-service.js';
import { createPublicEventListRuntime } from '../../worker/src/runtime/public-event-list-runtime.js';
import { createPublicEventDetailRuntime } from '../../worker/src/runtime/public-event-detail-runtime.js';
import { createPublicEventGeoJSONRuntime } from '../../worker/src/runtime/public-event-geojson-runtime.js';
import { createPublicEventUpdatesRuntime } from '../../worker/src/runtime/public-event-updates-runtime.js';
import type { SqlExecutor } from '../src/sql.js';

const TRACE_ID = 'trace-source-revision-freshness-transition';
const EVALUATION_TRACE_ID = 'trace-source-revision-freshness-evaluation';
const NOW = '2026-10-01T10:00:00.000000Z';
const TRANSITION_AT = '2026-10-01T10:05:00.000000Z';
const FUTURE = '2026-10-02T10:00:00.000000Z';
const EVENT_ID = 'event-source-revision-freshness';
const IMPACT_DIRECT = 'impact-source-revision-direct';
const IMPACT_UNRELATED = 'impact-source-revision-unrelated';
const SOURCE_ID = 'source-source-revision-freshness';
const PLACE_ID = 'place-source-revision-freshness-fixture';
const PRIVATE_SOURCE_TEXT = 'AUTHORED_PRIVATE_SOURCE_FIXTURE_ONLY';
const PRIVATE_CLAIM_TEXT = 'AUTHORED_PRIVATE_CLAIM_FIXTURE_ONLY';
const TEST_CONNECTION_STRING = 'postgresql://test-user:test-password@hyperdrive.example.invalid/waspada?sslmode=require';
const TEST_CURSOR_HMAC_KEY_HEX = Array.from({ length: 32 }, (_, index) =>
  (index + 1).toString(16).padStart(2, '0')).join('');

describe('PGlite source-revision freshness transition composition', () => {
  it('writes withdrawn freshness for exact directly supported targets without changing immutable publications', async () => {
    const database = await createTestDatabase();
    try {
      const migrations = await readMigrations(new URL('../migrations/', import.meta.url));
      await applyMigrations(database.executor, migrations);
      const evidenceRefId = await seedFixture(database);
      const before = await immutableSnapshot(database);
      const updatesHarness = await createPublicUpdatesApiHarness(database);
      const baselineSqlOperations = updatesHarness.sqlOperationCount();
      const baselineResponse = await updatesHarness.read();
      assert.equal(baselineResponse.status, 200);
      assert.equal(updatesHarness.sqlOperationCount() - baselineSqlOperations, 1,
        'the live updates baseline uses one request-scoped SQL operation');
      const baselinePage = await baselineResponse.json() as PublicEventUpdatesPage;
      assert.deepEqual(baselinePage.items, [], 'the baseline contains no earlier update entries');
      assert.deepEqual(Object.keys(baselinePage).sort(), [
        'checked_at', 'cursor_expires_at', 'items', 'next_cursor',
      ]);
      const baselineCursor = await updatesHarness.decodeCursor(baselinePage.next_cursor);
      assert.equal(baselineCursor.sequence, '0', 'the fixture begins at the empty updates watermark');

      const ledger = createSqlFreshnessTransitionLedger(database.executor);
      const coordinator = createSourceRevisionFreshnessTransitionCoordinator({
        candidates: createSourceRevisionReviewCandidateReader(database.executor),
        targets: createSourceRevisionFreshnessTargetReader(database.executor),
        ledger,
      });
      const result = await coordinator.processPage({
        datasetKind: 'live', now: TRANSITION_AT, limit: 100, traceId: EVALUATION_TRACE_ID,
      });

      assert.deepEqual(result, {
        outcome: 'completed',
        counts: {
          candidates: 2, invalidatingCandidates: 2, selectedTargets: 2,
          duplicateCandidates: 0, skippedCandidates: 0, written: 2, replayed: 0, noChange: 0,
        },
        nextCursor: null,
      });

      const transitions = await database.executor.query<{
        target_kind: string;
        impact_id: string | null;
        impact_version: number | null;
        previous_status: string;
        resulting_status: string;
        reason: string;
        source_observation_id: string | null;
        idempotency_key: string;
        request_fingerprint: string;
      }>(
        `SELECT target_kind, impact_id, impact_version, previous_status, resulting_status,
                reason, source_observation_id, idempotency_key, request_fingerprint
         FROM waspada.freshness_transitions
         WHERE dataset_kind = 'live' AND event_id = $1 AND event_version = 1
         ORDER BY target_kind, impact_id NULLS FIRST`,
        [EVENT_ID],
      );
      assert.equal(transitions.rows.length, 2);
      const claimSet = transitions.rows.find(({ target_kind }) => target_kind === 'event_claim_set');
      const directImpact = transitions.rows.find(({ target_kind }) => target_kind === 'impact');
      assert.deepEqual(claimSet && {
        target_kind: claimSet.target_kind,
        impact_id: claimSet.impact_id,
        impact_version: claimSet.impact_version,
        previous_status: claimSet.previous_status,
        resulting_status: claimSet.resulting_status,
        reason: claimSet.reason,
        source_observation_id: claimSet.source_observation_id,
      }, {
        target_kind: 'event_claim_set', impact_id: null, impact_version: null,
        previous_status: 'current', resulting_status: 'needs_update',
        reason: 'source_report_withdrawn', source_observation_id: 'observation-w-withdrawn',
      }, 'the exact withdrawn observation is attached to the event claim-set transition');
      assert.deepEqual(directImpact && {
        target_kind: directImpact.target_kind,
        impact_id: directImpact.impact_id,
        impact_version: directImpact.impact_version,
        previous_status: directImpact.previous_status,
        resulting_status: directImpact.resulting_status,
        reason: directImpact.reason,
        source_observation_id: directImpact.source_observation_id,
      }, {
        target_kind: 'impact', impact_id: IMPACT_DIRECT, impact_version: 1,
        previous_status: 'current', resulting_status: 'needs_update',
        reason: 'source_report_withdrawn', source_observation_id: 'observation-w-withdrawn',
      }, 'the direct impact links to the deterministic selected invalidating observation');
      assert.equal(transitions.rows.every(({ idempotency_key }) =>
        /^source-revision-freshness:[a-f0-9]{64}$/u.test(idempotency_key)), true);
      assert.equal(transitions.rows.every(({ request_fingerprint }) => /^[a-f0-9]{64}$/u.test(request_fingerprint)), true);

      const impactTransition = directImpact;
      assert.ok(impactTransition);
      const replayInput: AppendSourceRevisionFreshnessTransitionInput = {
        datasetKind: 'live',
        eventId: EVENT_ID,
        eventVersion: 1,
        target: { kind: 'impact', impactId: IMPACT_DIRECT, impactVersion: 1 },
        expectedSequence: 1,
        previousStatus: 'current',
        resultingStatus: 'needs_update',
        reason: 'source_report_withdrawn',
        evaluatedAt: TRANSITION_AT,
        traceId: EVALUATION_TRACE_ID,
        idempotencyKey: impactTransition.idempotency_key,
        evidenceReferenceIds: [],
        sourceObservationId: 'observation-w-withdrawn',
      };
      const replay = await ledger.append(replayInput);
      assert.equal(replay.outcome, 'replayed');
      if (replay.outcome === 'replayed') {
        assert.equal(replay.record.sourceObservationId, 'observation-w-withdrawn');
        assert.equal(replay.record.requestFingerprint, impactTransition.request_fingerprint);
      }
      assert.deepEqual(await ledger.append({
        ...replayInput,
        sourceObservationId: 'observation-current',
      }), { outcome: 'conflict', code: 'idempotency_key_reused' },
      'the source-observation ID participates in replay fingerprint validation');

      const publicViews = await database.executor.query<{
        freshness_status: string;
        event_record: string;
        lifecycle: string;
        impact_id: string;
        impact_record: string;
      }>(
        `SELECT event.freshness_status, event.record_json::text AS event_record, event.lifecycle,
                impact.impact_id, impact.record_json::text AS impact_record
         FROM waspada.public_event_versions AS event
         JOIN waspada.public_event_impacts AS impact
           ON impact.dataset_kind = event.dataset_kind
          AND impact.event_id = event.event_id AND impact.event_version = event.version
         WHERE event.dataset_kind = 'live' AND event.event_id = $1
         ORDER BY impact.impact_id`,
        [EVENT_ID],
      );
      assert.deepEqual(publicViews.rows.map(({ impact_id, impact_record }) => ({
        impact_id,
        freshness: JSON.parse(impact_record).freshness.status,
      })), [
        { impact_id: IMPACT_DIRECT, freshness: 'needs_update' },
        { impact_id: IMPACT_UNRELATED, freshness: 'current' },
      ]);
      assert.equal(publicViews.rows.every(({ freshness_status }) => freshness_status === 'needs_update'), true,
        'the event badge remains conservatively stale after the direct impact transition');
      for (const row of publicViews.rows) {
        assert.equal(row.lifecycle, 'unknown', 'freshness does not alter incident lifecycle');
        for (const serialized of [row.event_record, row.impact_record]) {
          assert.equal(serialized.includes('observation-w-withdrawn'), false);
          assert.equal(serialized.includes('source_observation_id'), false);
          assert.equal(serialized.includes(PRIVATE_SOURCE_TEXT), false);
        }
        assert.equal(row.event_record.includes(PRIVATE_CLAIM_TEXT), true,
          'the published claim text remains available in the event view');
      }

      assert.deepEqual(await immutableSnapshot(database), before,
        'event and impact records, publication decision, and history remain unchanged');
      await assertPublicApiReads(database, updatesHarness, {
        cursor: baselinePage.next_cursor,
        sequence: baselineCursor.sequence,
      });
      assert.equal(evidenceRefId.length > 0, true);
      await verifyWriterBoundary(database, ledger);
    } finally {
      await database.close();
    }
  });
});

async function assertPublicApiReads(
  database: TestDatabase,
  updatesHarness: PublicUpdatesApiHarness,
  baseline: { readonly cursor: string; readonly sequence: string },
): Promise<void> {
  let sqlOperations = 0;
  const withSqlExecutor = async <Result>(
    connectionString: string,
    operation: (executor: SqlExecutor) => Promise<Result>,
  ): Promise<Result> => {
    assert.equal(connectionString, TEST_CONNECTION_STRING);
    sqlOperations += 1;
    return operation(database.executor);
  };
  const runtimeConfiguration = {
    datasetMode: 'live',
    connectionString: TEST_CONNECTION_STRING,
  } as const;
  const listRuntime = await createPublicEventListRuntime({
    ...runtimeConfiguration,
    cursorHmacKeyHex: TEST_CURSOR_HMAC_KEY_HEX,
  }, { withSqlExecutor, now: () => Date.parse(TRANSITION_AT) });
  const detailRuntime = createPublicEventDetailRuntime(runtimeConfiguration, { withSqlExecutor });
  const geoJSONRuntime = createPublicEventGeoJSONRuntime(runtimeConfiguration, { withSqlExecutor });
  assert.ok(listRuntime);
  assert.ok(detailRuntime);
  assert.ok(geoJSONRuntime);

  const environment: WorkerEnvironment = { DATASET_MODE: 'live' };
  const { telemetry, telemetrySink } = updatesHarness;
  const listOperations = sqlOperations;
  const listResponse = await handlePublicApiRequest(
    new Request('https://api.example.invalid/api/v1/events?q=source%20freshness%20event'),
    environment,
    telemetrySink,
    listRuntime,
    detailRuntime,
    undefined,
    geoJSONRuntime,
  );
  assert.equal(listResponse.status, 200);
  assert.equal(sqlOperations - listOperations, 1, 'the live list uses one request-scoped SQL operation');
  const listPage = await listResponse.json() as EventPage;
  assert.equal(listPage.data.length, 1);
  const listEvent = listPage.data[0]!;

  const detailOperations = sqlOperations;
  const detailResponse = await handlePublicApiRequest(
    new Request(`https://api.example.invalid/api/v1/events/${EVENT_ID}`),
    environment,
    telemetrySink,
    listRuntime,
    detailRuntime,
    undefined,
    geoJSONRuntime,
  );
  assert.equal(detailResponse.status, 200);
  assert.equal(sqlOperations - detailOperations, 1, 'the live detail uses one request-scoped SQL operation');
  const detail = await detailResponse.json() as EventDetail;

  const geoJSONOperations = sqlOperations;
  const geoJSONResponse = await handlePublicApiRequest(
    new Request('https://api.example.invalid/api/v1/events.geojson'),
    environment,
    telemetrySink,
    listRuntime,
    detailRuntime,
    undefined,
    geoJSONRuntime,
  );
  assert.equal(geoJSONResponse.status, 200);
  assert.equal(sqlOperations - geoJSONOperations, 1, 'the live GeoJSON read uses one request-scoped SQL operation');
  assert.equal(geoJSONResponse.headers.get('content-type'), 'application/geo+json');
  const geoJSON = await geoJSONResponse.json() as PublicFeatureCollection;

  const updatesSqlOperations = updatesHarness.sqlOperationCount();
  const updatesResponse = await updatesHarness.read(baseline.cursor);
  assert.equal(updatesResponse.status, 200);
  assert.equal(updatesHarness.sqlOperationCount() - updatesSqlOperations, 1,
    'the live updates continuation uses one request-scoped SQL operation');
  const updatesPage = await updatesResponse.json() as PublicEventUpdatesPage;
  assert.deepEqual(updatesPage.items, [], 'a freshness-only transition creates no public update');
  assert.deepEqual(Object.keys(updatesPage).sort(), [
    'checked_at', 'cursor_expires_at', 'items', 'next_cursor',
  ]);
  const continuedCursor = await updatesHarness.decodeCursor(updatesPage.next_cursor);
  assert.equal(continuedCursor.sequence, baseline.sequence,
    'a freshness-only transition does not advance the opaque cursor sequence');
  assert.equal(updatesPage.cursor_expires_at, continuedCursor.expiresAt);

  assert.equal(listEvent.event_id, EVENT_ID);
  assert.equal(listEvent.version, 1);
  assert.equal(listEvent.title, 'Authored fictional source freshness event');
  assert.equal(listEvent.lifecycle, 'unknown', 'freshness does not change the published lifecycle');
  assert.deepEqual(listEvent.freshness, {
    status: 'needs_update',
    evaluated_at: NOW,
    review_due_at: FUTURE,
    basis: 'manual_review',
  });
  assert.deepEqual(impactFreshness(listEvent), [
    [IMPACT_DIRECT, {
      status: 'needs_update', evaluated_at: NOW, review_due_at: FUTURE, basis: 'manual_review',
    }],
    [IMPACT_UNRELATED, {
      status: 'current', evaluated_at: NOW, review_due_at: FUTURE, basis: 'manual_review',
    }],
  ]);
  assert.equal(listEvent.claims[0]?.text, PRIVATE_CLAIM_TEXT,
    'the published claim remains visible after the freshness transition');

  assert.equal(detail.event_id, EVENT_ID);
  assert.equal(detail.version, 1);
  assert.equal(detail.title, listEvent.title);
  assert.equal(detail.lifecycle, listEvent.lifecycle);
  assert.deepEqual(detail.freshness, listEvent.freshness);
  assert.deepEqual(impactFreshness(detail), impactFreshness(listEvent));
  assert.deepEqual(detail.claims, listEvent.claims);
  assert.deepEqual(detail.geometries, [], 'the authored fixture has no source-supported geometry');

  assert.deepEqual(geoJSON, { type: 'FeatureCollection', features: [] },
    'no supported geometry is represented as an empty collection, not a safety statement');
  const updateResponseJson = JSON.stringify(updatesPage);
  for (const privateMarker of [
    'observation-w-withdrawn',
    'revision-source-target',
    'revision-current',
    'revision-w-withdrawn',
    SOURCE_ID,
    PRIVATE_SOURCE_TEXT,
    PRIVATE_CLAIM_TEXT,
    'source_observation_id',
    'source_report_withdrawn',
    'freshness_transitions',
    'transition_sequence',
    'idempotency_key',
    'request_fingerprint',
    TEST_CURSOR_HMAC_KEY_HEX,
  ]) {
    assert.equal(updateResponseJson.includes(privateMarker), false,
      `public updates response leaked ${privateMarker}`);
  }

  const publicResponseJson = JSON.stringify({ listPage, detail, geoJSON });
  for (const privateMarker of [
    'observation-w-withdrawn',
    'revision-source-target',
    'revision-current',
    'revision-w-withdrawn',
    SOURCE_ID,
    PRIVATE_SOURCE_TEXT,
    'source_observation_id',
    'source_report_withdrawn',
    'freshness_transitions',
    'transition_sequence',
    'idempotency_key',
    'request_fingerprint',
  ]) {
    assert.equal(publicResponseJson.includes(privateMarker), false,
      `public API projection leaked ${privateMarker}`);
  }

  assert.equal(telemetry.length, 5, 'baseline, current views, and updates each emit bounded request telemetry');
  for (const record of telemetry) {
    assert.deepEqual(Object.keys(record).sort(), ['durationMs', 'eventName', 'route', 'status']);
    assert.equal(record.eventName, 'api_request');
    assert.equal('route' in record && record.route === 'events', true);
    assert.equal('status' in record && record.status === 200, true);
    assert.equal('durationMs' in record && Number.isFinite(record.durationMs)
      && record.durationMs >= 0, true);
  }
  const telemetryJson = JSON.stringify(telemetry);
  for (const privateMarker of [
    'observation-w-withdrawn',
    'revision-source-target',
    SOURCE_ID,
    PRIVATE_SOURCE_TEXT,
    PRIVATE_CLAIM_TEXT,
    'source_observation_id',
    'source_url',
    TEST_CONNECTION_STRING,
    TEST_CURSOR_HMAC_KEY_HEX,
    baseline.cursor,
    updatesPage.next_cursor,
  ]) {
    assert.equal(telemetryJson.includes(privateMarker), false,
      `API telemetry leaked ${privateMarker}`);
  }
}

interface PublicUpdatesApiHarness {
  readonly telemetry: TelemetryRecord[];
  readonly telemetrySink: { record(record: TelemetryRecord): void };
  read(cursor?: string): Promise<Response>;
  decodeCursor(cursor: string): Promise<{ readonly sequence: string; readonly expiresAt: string }>;
  sqlOperationCount(): number;
}

async function createPublicUpdatesApiHarness(database: TestDatabase): Promise<PublicUpdatesApiHarness> {
  let sqlOperations = 0;
  const telemetry: TelemetryRecord[] = [];
  const telemetrySink = { record: (record: TelemetryRecord) => telemetry.push(record) };
  const withSqlExecutor = async <Result>(
    connectionString: string,
    operation: (executor: SqlExecutor) => Promise<Result>,
  ): Promise<Result> => {
    assert.equal(connectionString, TEST_CONNECTION_STRING);
    sqlOperations += 1;
    return operation(database.executor);
  };
  const now = () => Date.parse(TRANSITION_AT);
  const updatesRuntime = await createPublicEventUpdatesRuntime({
    datasetMode: 'live',
    connectionString: TEST_CONNECTION_STRING,
    cursorHmacKeyHex: TEST_CURSOR_HMAC_KEY_HEX,
  }, { withSqlExecutor, now });
  assert.ok(updatesRuntime);

  const key = await globalThis.crypto.subtle.importKey(
    'raw',
    Uint8Array.from(TEST_CURSOR_HMAC_KEY_HEX.match(/.{2}/gu)!, (byte) => Number.parseInt(byte, 16)),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
  const cursorCodec = createPublicEventUpdatesCursorCodec({ key, now });
  const environment: WorkerEnvironment = { DATASET_MODE: 'live' };

  return {
    telemetry,
    telemetrySink,
    async read(cursor) {
      const query = cursor === undefined ? '' : `?cursor=${encodeURIComponent(cursor)}`;
      return handlePublicApiRequest(
        new Request(`https://api.example.invalid/api/v1/updates${query}`),
        environment,
        telemetrySink,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        updatesRuntime,
      );
    },
    decodeCursor: (cursor) => cursorCodec.decode(cursor),
    sqlOperationCount: () => sqlOperations,
  };
}

function impactFreshness(event: Pick<EventView, 'impacts'>): Array<[string, EventView['freshness']]> {
  return [...event.impacts]
    .sort((left, right) => left.impact_id.localeCompare(right.impact_id))
    .map((impact) => [impact.impact_id, impact.freshness]);
}

async function seedFixture(database: TestDatabase): Promise<string> {
  await database.executor.query(
    `INSERT INTO waspada.dataset_namespace_config (singleton, dataset_kind)
     VALUES (true, 'live') ON CONFLICT (singleton) DO NOTHING`,
  );
  await database.executor.query(
    `INSERT INTO waspada.traces (trace_id, dataset_kind, started_at, outcome, metadata)
     VALUES ($1, 'live', $2, 'open', '{"fixture":"authored-only"}'::jsonb),
            ($3, 'live', $2, 'open', '{"fixture":"authored-only"}'::jsonb)`,
    [TRACE_ID, NOW, EVALUATION_TRACE_ID],
  );
  await database.executor.query(
    `INSERT INTO waspada.source_registry
       (source_id, trace_id, registry_version, display_name, source_kind, remit, access_method,
        approved_hosts, access_restrictions, reuse_basis, registry_status, approval_status,
        health_status, auto_acquisition_enabled, auto_publication_policy)
     VALUES ($1, $2, 1, 'Authored fictional fixture', 'other', ARRAY['test'], 'manual_fixture',
       ARRAY[]::text[], ARRAY['fixture only'], ARRAY['authored test rows'], 'active', 'approved',
       'unknown', false, 'never')`,
    [SOURCE_ID, TRACE_ID],
  );

  const revisions = [
    'revision-source-target', 'revision-w-withdrawn', 'revision-current',
  ];
  for (const revisionId of revisions) {
    const text = `${PRIVATE_SOURCE_TEXT} ${revisionId}`;
    await database.executor.query(
      `INSERT INTO waspada.report_revisions
         (dataset_kind, report_revision_id, trace_id, source_id, canonical_url, content_hash,
          permitted_text, permitted_text_hash, normalization_version, retrieved_at,
          supersedes_id, revision_status, record_json)
       VALUES ('live', $1, $2, $3, 'https://fixture.invalid/authored-only', $4, $5, $6,
         'authored-fixture-v1', $7, $8, 'eligible', '{"fixture":"authored-only"}'::jsonb)`,
      [revisionId, TRACE_ID, SOURCE_ID, hash(`bytes:${revisionId}`), text, hash(text), NOW, null],
    );
  }

  const evidence = await database.executor.query<{ evidence_ref_id: string }>(
    `INSERT INTO waspada.evidence_references
       (dataset_kind, trace_id, report_revision_id, permitted_text_hash, span_start, span_end,
        offset_unit, relation)
     VALUES ('live', $1, 'revision-source-target', $2, 0, 8, 'unicode_code_points', 'supports')
     RETURNING evidence_ref_id::text AS evidence_ref_id`,
    [TRACE_ID, hash(`${PRIVATE_SOURCE_TEXT} revision-source-target`)],
  );
  const evidenceRefId = evidence.rows[0]?.evidence_ref_id;
  assert.ok(evidenceRefId);
  const unrelatedEvidence = await database.executor.query<{ evidence_ref_id: string }>(
    `INSERT INTO waspada.evidence_references
       (dataset_kind, trace_id, report_revision_id, permitted_text_hash, span_start, span_end,
        offset_unit, relation)
     VALUES ('live', $1, 'revision-current', $2, 0, 8, 'unicode_code_points', 'supports')
     RETURNING evidence_ref_id::text AS evidence_ref_id`,
    [TRACE_ID, hash(`${PRIVATE_SOURCE_TEXT} revision-current`)],
  );
  const unrelatedEvidenceRefId = unrelatedEvidence.rows[0]?.evidence_ref_id;
  assert.ok(unrelatedEvidenceRefId);

  for (const [index, revisionId, referenceId] of [
    [1, 'revision-source-target', evidenceRefId],
    [2, 'revision-current', unrelatedEvidenceRefId],
  ] as const) {
    await database.executor.query(
      `INSERT INTO waspada.public_attribution_review_decisions
         (review_decision_id, dataset_kind, evidence_ref_id, report_revision_id,
          permitted_text_hash, span_start, span_end, offset_unit, relation, review_version,
          decision_status, rights_basis_ref, public_display_name, source_url, source_published_at,
          source_observed_at, reviewer_id, decision_reason, reviewed_at)
       VALUES ($1, 'live', $2, $3, $4, 0, 8, 'unicode_code_points', 'supports', 1,
         'approved', 'authored test fixture rights basis', 'Authored fictional source',
         'https://source.example.invalid/authored-only', $5, $5, 'reviewer-synthetic',
         'Authored test attribution', $5)`,
      [`attribution-review-source-freshness-fixture-${index}`, referenceId, revisionId,
        hash(`${PRIVATE_SOURCE_TEXT} ${revisionId}`), NOW],
    );
  }

  const observations = [
    { id: 'observation-w-withdrawn', assertion: 'revision-w-withdrawn', state: 'withdrawn', replacement: null },
    { id: 'observation-current', assertion: 'revision-current', state: 'current', replacement: null },
  ] as const;
  for (const observation of observations) {
    await database.executor.query(
      `INSERT INTO waspada.report_revision_source_observations
         (dataset_kind, observation_id, trace_id, source_id, target_report_revision_id,
          assertion_report_revision_id, asserted_state, replacement_report_revision_id, retrieved_at)
       VALUES ('live', $1, $2, $3, 'revision-source-target', $4, $5, $6, $7)`,
      [observation.id, TRACE_ID, SOURCE_ID, observation.assertion, observation.state,
        observation.replacement, NOW],
    );
  }

  const candidateId = 'candidate-source-freshness-fixture';
  const contextId = 'context-source-freshness-fixture';
  const proposalId = 'proposal-source-freshness-fixture';
  await database.executor.query(
    `INSERT INTO waspada.extraction_results
       (dataset_kind, candidate_id, trace_id, report_revision_id, category, record_json)
     VALUES ('live', $1, $2, 'revision-source-target', NULL, '{"fixture":"authored-only"}'::jsonb)`,
    [candidateId, TRACE_ID],
  );
  await database.executor.query(
    `INSERT INTO waspada.grounding_contexts
       (dataset_kind, context_id, trace_id, candidate_id, retrieval_version, index_version,
        sufficient, record_json)
     VALUES ('live', $1, $2, $3, 'fixture-retrieval-v1', 'fixture-index-v1', false,
       '{"fixture":"authored-only"}'::jsonb)`,
    [contextId, TRACE_ID, candidateId],
  );
  await database.executor.query(
    `INSERT INTO waspada.event_proposals
       (dataset_kind, proposal_id, trace_id, candidate_id, context_id, proposed_at, record_json)
     VALUES ('live', $1, $2, $3, $4, $5, '{"fixture":"authored-only"}'::jsonb)`,
    [proposalId, TRACE_ID, candidateId, contextId, NOW],
  );
  await database.executor.query(
    `INSERT INTO waspada.scope_name_review_decisions
       (review_decision_id, entity_type, entity_id, locale, review_version, decision_status,
        display_name, provenance_ref, reviewer_id, decision_reason, reviewed_at)
     VALUES ('scope-review-source-freshness-fixture', 'place', $1, 'id-ID', 1, 'approved',
       'Authored fictional place', 'authored fixture', 'reviewer-synthetic',
       'Authored test display name', $2)`,
    [PLACE_ID, NOW],
  );

  await database.executor.transaction(async (transaction) => {
    await transaction.execute('SET CONSTRAINTS ALL DEFERRED');
    const supportReference = {
      report_revision_id: 'revision-source-target',
      permitted_text_hash: hash(`${PRIVATE_SOURCE_TEXT} revision-source-target`),
      span_start: 0,
      span_end: 8,
      offset_unit: 'unicode_code_points',
      relation: 'supports',
    };
    const unrelatedSupportReference = {
      report_revision_id: 'revision-current',
      permitted_text_hash: hash(`${PRIVATE_SOURCE_TEXT} revision-current`),
      span_start: 0,
      span_end: 8,
      offset_unit: 'unicode_code_points',
      relation: 'supports',
    };
    const fixtureScope = {
      place_ids: [PLACE_ID], service_ids: [], institution_ids: [], audience_ids: [], geometry_ids: [],
    };
    const eventRecord = {
      schema_version: '2.0', trace_id: TRACE_ID, record_type: 'Event', dataset_kind: 'live',
      event_id: EVENT_ID, version: 1, supersedes_version: null,
      title: 'Authored fictional source freshness event', summary: 'Authored fixture only.',
      category: 'transport_road_incidents', tags: [], lifecycle: 'unknown',
      freshness: { status: 'current', evaluated_at: NOW, review_due_at: FUTURE, basis: 'manual_review' },
      event_time: { start: null, end: null, precision: 'unknown' },
      validity: { valid_from: null, valid_until: FUTURE },
      scope: fixtureScope,
      claims: [
        {
          claim_id: 'claim-source-target', text: PRIVATE_CLAIM_TEXT,
          event_time: { start: null, end: null, precision: 'unknown' },
          validity: { valid_from: null, valid_until: FUTURE },
          scope: fixtureScope,
          qualifiers: [], support: [supportReference], contradictions: [], context_evidence: [],
          origin_ids: ['origin-source-freshness-fixture'], evidence_label: 'attributed_report',
        },
        {
          claim_id: 'claim-source-unrelated',
          text: 'Authored unrelated claim remains supported by a current report.',
          event_time: { start: null, end: null, precision: 'unknown' },
          validity: { valid_from: null, valid_until: FUTURE },
          scope: fixtureScope,
          qualifiers: [], support: [unrelatedSupportReference], contradictions: [], context_evidence: [],
          origin_ids: ['origin-source-freshness-unrelated-fixture'], evidence_label: 'attributed_report',
        },
      ],
      impact_refs: [
        { impact_id: IMPACT_DIRECT, version: 1 },
        { impact_id: IMPACT_UNRELATED, version: 1 },
      ],
      publication_status: 'published', withdrawal_reason: null,
      publication_decision_id: 'decision-source-freshness-fixture', published_at: NOW, withdrawn_at: null,
    };
    await transaction.query(
      `INSERT INTO waspada.publication_decisions
         (dataset_kind, decision_id, trace_id, proposal_id, policy_version, event_id, event_version,
          decided_at, record_json)
       VALUES ('live', 'decision-source-freshness-fixture', $1, $2, 'fixture-policy-v1', $3, 1,
         $4, '{"fixture":"authored-only"}'::jsonb)`,
      [TRACE_ID, proposalId, EVENT_ID, NOW],
    );
    await transaction.query(
      `INSERT INTO waspada.event_versions
         (dataset_kind, event_id, version, trace_id, supersedes_version, title, summary, category,
          lifecycle, publication_status, withdrawal_reason, publication_decision_id, published_at,
          withdrawn_at, record_json)
       VALUES ('live', $1, 1, $2, NULL, 'Authored fictional source freshness event',
         'Authored fixture only.', 'transport_road_incidents', 'unknown', 'published', NULL,
         'decision-source-freshness-fixture', $3, NULL, $4::jsonb)`,
      [EVENT_ID, TRACE_ID, NOW, JSON.stringify(eventRecord)],
    );
    for (const claim of eventRecord.claims) {
      const isDirectClaim = claim.claim_id === 'claim-source-target';
      await transaction.query(
        `INSERT INTO waspada.event_claims
           (dataset_kind, event_id, event_version, claim_id, claim_text, evidence_label, record_json)
         VALUES ('live', $1, 1, $2, $3, 'attributed_report', $4::jsonb)`,
        [EVENT_ID, claim.claim_id, claim.text,
          JSON.stringify(claim)],
      );
      await transaction.query(
        `INSERT INTO waspada.event_claim_evidence
           (dataset_kind, event_id, event_version, claim_id, evidence_kind, evidence_ref_id)
         VALUES ('live', $1, 1, $2, 'support', $3::bigint)`,
        [EVENT_ID, claim.claim_id, isDirectClaim ? evidenceRefId : unrelatedEvidenceRefId],
      );
    }
    for (const [impactId, isDirect, validUntil] of [
      [IMPACT_DIRECT, true, FUTURE], [IMPACT_UNRELATED, false, FUTURE],
    ] as const) {
      const impactRecord = {
        schema_version: '2.0', trace_id: TRACE_ID, record_type: 'Impact', dataset_kind: 'live',
        impact_id: impactId, version: 1, event_id: EVENT_ID, event_version: 1,
        impact_type: 'road_closure',
        title: impactId === IMPACT_DIRECT ? 'Authored directly affected impact' : 'Authored unrelated impact',
        description: 'Authored impact fixture only.', lifecycle: 'unknown',
        freshness: { status: 'current', evaluated_at: NOW, review_due_at: FUTURE, basis: 'manual_review' },
        event_time: { start: null, end: null, precision: 'unknown' },
        validity: { valid_from: null, valid_until: validUntil },
        scope: fixtureScope,
        supporting_claim_ids: [isDirect ? 'claim-source-target' : 'claim-source-unrelated'],
        published_at: NOW,
      };
      await transaction.query(
        `INSERT INTO waspada.impact_versions
           (dataset_kind, impact_id, version, trace_id, event_id, event_version, impact_type,
            lifecycle, published_at, record_json)
         VALUES ('live', $1, 1, $2, $3, 1, 'road_closure', 'unknown', $4, $5::jsonb)`,
        [impactId, TRACE_ID, EVENT_ID, NOW, JSON.stringify(impactRecord)],
      );
      await transaction.query(
        `INSERT INTO waspada.event_impact_refs
           (dataset_kind, event_id, event_version, impact_id, impact_version)
         VALUES ('live', $1, 1, $2, 1)`,
        [EVENT_ID, impactId],
      );
      await transaction.query(
        `INSERT INTO waspada.impact_claim_support
           (dataset_kind, impact_id, impact_version, event_id, event_version, claim_id)
         VALUES ('live', $1, 1, $2, 1, $3)`,
        [impactId, EVENT_ID, isDirect ? 'claim-source-target' : 'claim-source-unrelated'],
      );
    }

    const roleEvent = {
      ...eventRecord,
      event_id: 'event-role-source-writer',
      title: 'Authored role capability fixture',
      claims: [{ claim_id: 'claim-role-source-writer', text: 'Authored fixture claim.' }],
      impact_refs: [],
      validity: { valid_from: null, valid_until: FUTURE },
      publication_decision_id: 'decision-role-source-writer',
    };
    await transaction.query(
      `INSERT INTO waspada.publication_decisions
         (dataset_kind, decision_id, trace_id, proposal_id, policy_version, event_id, event_version,
          decided_at, record_json)
       VALUES ('live', 'decision-role-source-writer', $1, $2, 'fixture-policy-v1',
         'event-role-source-writer', 1, $3, '{"fixture":"authored-only"}'::jsonb)`,
      [TRACE_ID, proposalId, NOW],
    );
    await transaction.query(
      `INSERT INTO waspada.event_versions
         (dataset_kind, event_id, version, trace_id, supersedes_version, title, summary, category,
          lifecycle, publication_status, withdrawal_reason, publication_decision_id, published_at,
          withdrawn_at, record_json)
       VALUES ('live', 'event-role-source-writer', 1, $1, NULL, 'Authored role capability fixture',
         'Authored fixture only.', 'transport_road_incidents', 'unknown', 'published', NULL,
         'decision-role-source-writer', $2, NULL, $3::jsonb)`,
      [TRACE_ID, NOW, JSON.stringify(roleEvent)],
    );
  });

  return evidenceRefId;
}

async function verifyWriterBoundary(
  database: TestDatabase,
  ledger: ReturnType<typeof createSqlFreshnessTransitionLedger>,
): Promise<void> {
  await database.executor.execute('SET ROLE waspada_l4_freshness_writer');
  try {
    await assert.rejects(
      database.executor.query('SELECT observation_id FROM waspada.report_revision_source_observations LIMIT 1'),
      /permission denied/iu,
      'the freshness writer has no direct source-observation read capability',
    );
    const written = await ledger.append({
      datasetKind: 'live',
      eventId: 'event-role-source-writer',
      eventVersion: 1,
      target: { kind: 'event_claim_set' },
      expectedSequence: 1,
      previousStatus: 'current',
      resultingStatus: 'needs_update',
      reason: 'source_report_withdrawn',
      evaluatedAt: NOW,
      traceId: EVALUATION_TRACE_ID,
      idempotencyKey: 'source-revision-freshness:role-capability-fixture',
      evidenceReferenceIds: [],
      sourceObservationId: 'observation-w-withdrawn',
    });
    assert.equal(written.outcome, 'written',
      'the existing freshness writer can insert/select the new private ledger column');
    if (written.outcome === 'written') {
      assert.equal(written.record.sourceObservationId, 'observation-w-withdrawn');
    }
  } finally {
    await database.executor.execute('RESET ROLE');
  }
}

async function immutableSnapshot(database: TestDatabase) {
  const [events, impacts, decisions, historyCount] = await Promise.all([
    database.executor.query<{ event_id: string; version: number; publication_status: string; lifecycle: string; record_json: string }>(
      `SELECT event_id, version, publication_status, lifecycle, record_json::text AS record_json
       FROM waspada.event_versions WHERE dataset_kind = 'live'
         AND event_id IN ($1, 'event-role-source-writer') ORDER BY event_id, version`,
      [EVENT_ID],
    ),
    database.executor.query<{ impact_id: string; version: number; record_json: string }>(
      `SELECT impact_id, version, record_json::text AS record_json
       FROM waspada.impact_versions WHERE dataset_kind = 'live' AND event_id = $1 ORDER BY impact_id, version`,
      [EVENT_ID],
    ),
    database.executor.query<{ decision_id: string; event_id: string; event_version: number }>(
      `SELECT decision_id, event_id, event_version FROM waspada.publication_decisions
       WHERE dataset_kind = 'live' AND event_id IN ($1, 'event-role-source-writer') ORDER BY decision_id`,
      [EVENT_ID],
    ),
    database.executor.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM waspada.event_versions
       WHERE dataset_kind = 'live' AND event_id IN ($1, 'event-role-source-writer')`,
      [EVENT_ID],
    ),
  ]);
  return { events: events.rows, impacts: impacts.rows, decisions: decisions.rows, historyCount: historyCount.rows };
}

function hash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
