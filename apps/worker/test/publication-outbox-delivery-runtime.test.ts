import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import {
  createSqlPublicationOutboxDeliveryRepository,
  type PublicationNotice,
} from '../../db/src/publication-outbox-delivery.js';
import type { TransactionalSqlExecutor } from '../../db/src/sql.js';
import { applyMigrations, readMigrations } from '../../db/src/migrations.js';
import { createTestDatabase, type TestDatabase } from '../../db/test/harness.js';
import {
  consolePublicationOutboxDeliveryTelemetry,
  PUBLICATION_OUTBOX_DELIVERY_EVENT_NAME,
  type PublicationOutboxDeliveryTelemetryRecord,
} from '../src/layers/l5-evaluation-monitoring/publication-outbox-delivery-telemetry.js';
import {
  createPublicationOutboxDeliveryRuntime,
  PublicationOutboxDeliveryRuntimeError,
  type PublicationNoticeSink,
} from '../src/runtime/publication-outbox-delivery-runtime.js';

const START = Date.parse('2026-10-04T05:00:00.000Z');
const connectionString =
  'postgresql://delivery-user:delivery-secret@delivery-hyperdrive.example.invalid/waspada?sslmode=require';
const config = {
  datasetMode: 'live',
  relayEnabled: 'true',
  deliveryWriterConnectionString: connectionString,
};

describe('publication outbox delivery runtime', () => {
  it('is dormant without exact-live opt-in, connection, or an injected idempotent sink', () => {
    let runnerCalls = 0;
    const records: PublicationOutboxDeliveryTelemetryRecord[] = [];
    const sink: PublicationNoticeSink = { async deliver() { return { outcome: 'delivered' }; } };
    const dependencies = {
      sink,
      withTransactionalSqlExecutor: async <Result>(_connection: string, operation: (executor: TransactionalSqlExecutor) => Promise<Result>) => {
        runnerCalls += 1;
        return operation(fakeExecutor());
      },
      telemetry: { record(record: PublicationOutboxDeliveryTelemetryRecord) { records.push(record); } },
    };

    assert.equal(createPublicationOutboxDeliveryRuntime({ ...config, datasetMode: 'demo' }, dependencies), undefined);
    assert.equal(createPublicationOutboxDeliveryRuntime({ ...config, relayEnabled: 'false' }, dependencies), undefined);
    assert.equal(createPublicationOutboxDeliveryRuntime({ ...config, deliveryWriterConnectionString: undefined }, dependencies), undefined);
    assert.equal(createPublicationOutboxDeliveryRuntime(config, { ...dependencies, sink: undefined }), undefined);
    assert.equal(runnerCalls, 0);
    assert.deepEqual(records, []);
  });

  it('records uncertain sink throws as retryable and reuses one key for one logical fake-sink effect', async () => {
    const database = await createFixtureDatabase();
    try {
      const telemetry: PublicationOutboxDeliveryTelemetryRecord[] = [];
      const calls: Array<{ notice: PublicationNotice; key: string }> = [];
      const effects = new Set<string>();
      let shouldThrow = true;
      let completedAt = START;
      let reservationNumber = 0;
      const sink: PublicationNoticeSink = {
        async deliver(notice, key) {
          calls.push({ notice, key });
          if (!effects.has(key)) effects.add(key);
          if (shouldThrow) {
            shouldThrow = false;
            throw new Error('private driver message and remote response body');
          }
          return { outcome: 'delivered' };
        },
      };
      const runtime = createPublicationOutboxDeliveryRuntime(config, {
        sink,
        withTransactionalSqlExecutor: async (_connection, operation) => operation(database.executor),
        clock: () => completedAt,
        reservationKey: () => `runtime-pass-${++reservationNumber}`,
        telemetry: { record(record) { telemetry.push(record); } },
      });
      assert.ok(runtime);

      const first = await runtime.relay(START);
      assert.deepEqual(first.counts, { reserved: 1, delivered: 0, retryableFailures: 1, permanentFailures: 0 });
      const retryRow = await database.executor.query<{
        outcome: string;
        failure_classification: string | null;
        retry_after: string | null;
      }>(
        `SELECT outcome, failure_classification, retry_after::text AS retry_after
         FROM waspada.publication_outbox_delivery_results`,
      );
      assert.equal(retryRow.rows[0]?.outcome, 'retryable_failure');
      assert.equal(retryRow.rows[0]?.failure_classification, 'unknown');
      assert.equal(Date.parse(retryRow.rows[0]?.retry_after ?? '') - START, 1_000);
      assert.doesNotMatch(JSON.stringify(retryRow.rows), /private driver|response body/u);

      completedAt = START + 1_000;
      const second = await runtime.relay(START + 1_000);
      assert.deepEqual(second.counts, { reserved: 1, delivered: 1, retryableFailures: 0, permanentFailures: 0 });
      assert.equal(calls.length, 2);
      assert.equal(calls[0]?.key, calls[1]?.key);
      assert.equal(calls[0]?.key, 'outbox-delivery-000');
      assert.equal(effects.size, 1);
      for (const call of calls) {
        assert.deepEqual(Object.keys(call.notice).sort(), ['eventId', 'eventKind', 'eventVersion', 'occurredAt']);
        assert.equal(call.notice.eventKind, 'event_version_published');
        assert.doesNotMatch(JSON.stringify(call), /trace|claims?|evidence|geometry|content|payload/u);
      }
      assert.equal(telemetry.length, 2);
      assert.equal(telemetry[0]?.outcome, 'completed');
      assert.equal(telemetry[1]?.outcome, 'completed');
      assert.doesNotMatch(JSON.stringify(telemetry), /outbox-delivery|event-outbox|driver message|response body/u);
      assert.equal((await countRows(database, 'publication_outbox_delivery_attempts')), 2);
      assert.equal((await countRows(database, 'publication_outbox_delivery_results')), 2);
    } finally {
      await database.close();
    }
  });

  it('recovers when sink success precedes a failed result write, with only one logical effect', async () => {
    const database = await createFixtureDatabase();
    try {
      const calls: Array<{ notice: PublicationNotice; key: string }> = [];
      const effects = new Set<string>();
      let completedAt = START;
      let reservationNumber = 0;
      let failFirstResult = true;
      const sink: PublicationNoticeSink = {
        async deliver(notice, key) {
          calls.push({ notice, key });
          effects.add(key);
          return { outcome: 'delivered' };
        },
      };
      const telemetry: PublicationOutboxDeliveryTelemetryRecord[] = [];
      const runtime = createPublicationOutboxDeliveryRuntime(config, {
        sink,
        withTransactionalSqlExecutor: async (_connection, operation) => operation(database.executor),
        createRepository(executor) {
          const repository = createSqlPublicationOutboxDeliveryRepository(executor);
          return {
            claimPage: (input) => repository.claimPage(input),
            async recordResult(input) {
              if (failFirstResult) {
                failFirstResult = false;
                throw new Error('private SQL host and credential details');
              }
              return repository.recordResult(input);
            },
          };
        },
        clock: () => completedAt,
        reservationKey: () => `persistence-gap-${++reservationNumber}`,
        telemetry: { record(record) { telemetry.push(record); } },
      });
      assert.ok(runtime);

      await assert.rejects(
        runtime.relay(START),
        (error: unknown) => error instanceof PublicationOutboxDeliveryRuntimeError
          && error.code === 'DELIVERY_FAILED'
          && error.message === 'The publication notice delivery pass could not be completed.',
      );
      assert.equal((await countRows(database, 'publication_outbox_delivery_results')), 0);
      completedAt = START + 60_001;
      const recovered = await runtime.relay(START + 60_001);
      assert.deepEqual(recovered.counts, { reserved: 1, delivered: 1, retryableFailures: 0, permanentFailures: 0 });

      assert.equal(calls.length, 2);
      assert.equal(calls[0]?.key, calls[1]?.key);
      assert.equal(calls[0]?.notice.eventId, calls[1]?.notice.eventId);
      assert.equal(effects.size, 1);
      assert.equal((await countRows(database, 'publication_outbox_delivery_attempts')), 2);
      assert.equal((await countRows(database, 'publication_outbox_delivery_results')), 1);
      assert.equal(telemetry[0]?.outcome, 'failed');
      assert.equal(telemetry[1]?.outcome, 'completed');
      assert.doesNotMatch(JSON.stringify(telemetry), /outbox-delivery|event-outbox|SQL host|credential details/u);
    } finally {
      await database.close();
    }
  });

  it('uses a finite timeout and stores only the fixed timeout classification', async () => {
    const database = await createFixtureDatabase();
    try {
      const telemetry: PublicationOutboxDeliveryTelemetryRecord[] = [];
      let completedAt = START;
      const sink: PublicationNoticeSink = {
        deliver(_notice, _key, signal) {
          return new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(new Error('private sink response')), { once: true });
          });
        },
      };
      const runtime = createPublicationOutboxDeliveryRuntime(config, {
        sink,
        withTransactionalSqlExecutor: async (_connection, operation) => operation(database.executor),
        clock: () => completedAt,
        reservationKey: () => 'timeout-pass',
        timeoutMs: 10,
        telemetry: { record(record) { telemetry.push(record); } },
      });
      assert.ok(runtime);

      const result = await runtime.relay(START);
      assert.deepEqual(result.counts, { reserved: 1, delivered: 0, retryableFailures: 1, permanentFailures: 0 });
      completedAt = START + 10;
      const stored = await database.executor.query<{ outcome: string; failure_classification: string | null }>(
        'SELECT outcome, failure_classification FROM waspada.publication_outbox_delivery_results',
      );
      assert.deepEqual(stored.rows, [{ outcome: 'retryable_failure', failure_classification: 'timeout' }]);
      assert.doesNotMatch(JSON.stringify(telemetry), /private sink response/u);
    } finally {
      await database.close();
    }
  });

  it('persists permanent sink outcomes, stops on storage failure, and isolates telemetry failures', async () => {
    const database = await createFixtureDatabase(2);
    try {
      const sinkCalls: string[] = [];
      const sink: PublicationNoticeSink = {
        async deliver(notice) {
          sinkCalls.push(notice.eventId);
          return { outcome: 'permanent_failure', failureClassification: 'permanent_rejection' };
        },
      };
      const records: PublicationOutboxDeliveryTelemetryRecord[] = [];
      const runtime = createPublicationOutboxDeliveryRuntime(config, {
        sink,
        withTransactionalSqlExecutor: async (_connection, operation) => operation(database.executor),
        clock: () => START,
        reservationKey: () => 'permanent-pass',
        telemetry: { record(record) { records.push(record); throw new Error('telemetry sink secret'); } },
      });
      assert.ok(runtime);
      const result = await runtime.relay(START);
      assert.deepEqual(result.counts, { reserved: 2, delivered: 0, retryableFailures: 0, permanentFailures: 2 });
      assert.equal(sinkCalls.length, 2);
      assert.equal(records[0]?.outcome, 'completed');
      assert.doesNotMatch(JSON.stringify(records), /event-outbox|outbox-delivery|telemetry sink secret/u);
    } finally {
      await database.close();
    }
  });

  it('emits only a closed telemetry allowlist and tolerates malformed records', () => {
    const logs: unknown[] = [];
    const originalLog = console.log;
    console.log = ((...args: unknown[]) => { logs.push(args[0]); }) as typeof console.log;
    try {
      consolePublicationOutboxDeliveryTelemetry.record({
        eventName: PUBLICATION_OUTBOX_DELIVERY_EVENT_NAME,
        outcome: 'completed',
        durationMs: 4,
        counts: { reserved: 1, delivered: 1, retryableFailures: 0, permanentFailures: 0 },
      });
      consolePublicationOutboxDeliveryTelemetry.record({
        eventName: PUBLICATION_OUTBOX_DELIVERY_EVENT_NAME,
        outcome: 'completed',
        durationMs: 4,
        counts: { reserved: 21, delivered: 0, retryableFailures: 0, permanentFailures: 0 },
      } as unknown as PublicationOutboxDeliveryTelemetryRecord);
      consolePublicationOutboxDeliveryTelemetry.record({
        eventName: PUBLICATION_OUTBOX_DELIVERY_EVENT_NAME,
        outcome: 'completed',
        durationMs: 4,
        counts: { reserved: 1, delivered: 1, retryableFailures: 0, permanentFailures: 0 },
        eventId: 'private-event-id',
      } as unknown as PublicationOutboxDeliveryTelemetryRecord);
    } finally {
      console.log = originalLog;
    }
    assert.equal(logs.length, 1);
    assert.deepEqual(Object.keys(logs[0] as object).sort(), [
      'delivered_count', 'duration_ms', 'event_name', 'outcome', 'permanent_failure_count',
      'reserved_count', 'retryable_failure_count',
    ]);
    assert.doesNotMatch(JSON.stringify(logs), /private-event-id/u);
  });
});

async function createFixtureDatabase(outboxCount = 1): Promise<TestDatabase> {
  const database = await createTestDatabase();
  try {
    const migrations = await readMigrations(new URL('../../db/migrations/', import.meta.url));
    await applyMigrations(database.executor, migrations);
    await seedLiveShapedOutbox(database, outboxCount);
    return database;
  } catch (error) {
    await database.close();
    throw error;
  }
}

async function seedLiveShapedOutbox(database: TestDatabase, count: number): Promise<void> {
  const traceId = 'trace-worker-outbox-delivery-fixture';
  const at = new Date(START).toISOString();
  const permittedText = 'Synthetic-only fixture sentence for runtime delivery tests.';
  const textHash = sha256(permittedText);
  await database.executor.query(
    `INSERT INTO waspada.traces (trace_id, dataset_kind, started_at, outcome, metadata)
     VALUES ($1, 'live', $2, 'open', '{"fixture":"authored-synthetic-live-shaped-only"}'::jsonb)`,
    [traceId, at],
  );
  await database.executor.query(
    `INSERT INTO waspada.source_registry
       (source_id, trace_id, registry_version, display_name, source_kind, remit, access_method,
        approved_hosts, access_restrictions, reuse_basis, registry_status, approval_status,
        health_status, auto_acquisition_enabled, auto_publication_policy)
     VALUES ('source-worker-outbox-fixture', $1, 1, 'Authored fixture source', 'other', ARRAY['test'],
       'manual_fixture', ARRAY[]::text[], ARRAY['fixture only'], ARRAY['synthetic fixture only'],
       'active', 'approved', 'unknown', false, 'never')`,
    [traceId],
  );
  await database.executor.query(
    `INSERT INTO waspada.report_revisions
       (dataset_kind, report_revision_id, trace_id, source_id, canonical_url, content_hash,
        permitted_text, permitted_text_hash, normalization_version, retrieved_at, revision_status, record_json)
     VALUES ('live', 'revision-worker-outbox-fixture', $1, 'source-worker-outbox-fixture',
       'https://synthetic.invalid/worker-outbox-fixture', $2, $3, $4, 'fixture-normalization-v1',
       $5, 'eligible', '{"fixture":"authored-synthetic-live-shaped-only"}'::jsonb)`,
    [traceId, sha256('synthetic fixture bytes'), permittedText, textHash, at],
  );
  await database.executor.query(
    `INSERT INTO waspada.extraction_results
       (dataset_kind, candidate_id, trace_id, report_revision_id, category, record_json)
     VALUES ('live', 'candidate-worker-outbox-fixture', $1,
       'revision-worker-outbox-fixture', NULL,
       '{"fixture":"authored-synthetic-live-shaped-only"}'::jsonb)`,
    [traceId],
  );
  await database.executor.query(
    `INSERT INTO waspada.grounding_contexts
       (dataset_kind, context_id, trace_id, candidate_id, retrieval_version, index_version,
        sufficient, record_json)
     VALUES ('live', 'context-worker-outbox-fixture', $1, 'candidate-worker-outbox-fixture',
       'fixture-retrieval-v1', 'fixture-index-v1', false,
       '{"fixture":"authored-synthetic-live-shaped-only"}'::jsonb)`,
    [traceId],
  );
  await database.executor.query(
    `INSERT INTO waspada.event_proposals
       (dataset_kind, proposal_id, trace_id, candidate_id, context_id, proposed_at, record_json)
     VALUES ('live', 'proposal-worker-outbox-fixture', $1, 'candidate-worker-outbox-fixture',
       'context-worker-outbox-fixture', $2,
       '{"fixture":"authored-synthetic-live-shaped-only"}'::jsonb)`,
    [traceId, at],
  );

  for (let index = 0; index < count; index += 1) {
    const eventId = `event-outbox-${String(index).padStart(3, '0')}`;
    const decisionId = `${eventId}-decision`;
    const occurredAt = new Date(START + index * 1_000).toISOString();
    const record = {
      schema_version: '2.0',
      record_type: 'Event',
      dataset_kind: 'live',
      event_id: eventId,
      version: 1,
      claims: [{ claim_id: 'claim-fixture' }],
      impact_refs: [],
      fixture: 'authored-synthetic-live-shaped-only',
    };
    await database.executor.transaction(async (transaction) => {
      await transaction.query(
        `INSERT INTO waspada.publication_decisions
           (dataset_kind, decision_id, trace_id, proposal_id, policy_version,
            event_id, event_version, decided_at, record_json)
         VALUES ('live', $1, $2, 'proposal-worker-outbox-fixture', 'fixture-policy-v1',
           $3, 1, $4, '{"fixture":"authored-synthetic-live-shaped-only"}'::jsonb)`,
        [decisionId, traceId, eventId, occurredAt],
      );
      await transaction.query(
        `INSERT INTO waspada.event_versions
           (dataset_kind, event_id, version, trace_id, supersedes_version, title, summary,
            category, lifecycle, publication_status, withdrawal_reason, publication_decision_id,
            published_at, withdrawn_at, record_json)
         VALUES ('live', $1, 1, $2, NULL, 'Authored synthetic fixture event',
           'Fixture only; no incident was observed or evaluated.', 'group_specific_critical_notices',
           'unknown', 'published', NULL, $3, $4, NULL, $5::jsonb)`,
        [eventId, traceId, decisionId, occurredAt, JSON.stringify(record)],
      );
      await transaction.query(
        `INSERT INTO waspada.publication_outbox
           (outbox_id, dataset_kind, event_id, event_version, event_kind, trace_id, occurred_at)
         VALUES ($1, 'live', $2, 1, 'event_version_published', $3, $4)`,
        [`outbox-delivery-${String(index).padStart(3, '0')}`, eventId, traceId, occurredAt],
      );
    });
  }
}

async function countRows(database: TestDatabase, table: 'publication_outbox_delivery_attempts' | 'publication_outbox_delivery_results'): Promise<number> {
  const result = await database.executor.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM waspada.${table}`,
  );
  return Number(result.rows[0]?.count ?? 0);
}

function fakeExecutor(): TransactionalSqlExecutor {
  return {
    async query<Row extends object>() { return { rows: [] as readonly Row[] }; },
    async execute() {},
    async transaction<Result>(work: (transaction: import('../../db/src/sql.js').SqlExecutor) => Promise<Result>) {
      return work(this);
    },
  };
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
