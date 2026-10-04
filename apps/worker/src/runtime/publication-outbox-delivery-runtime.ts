import { randomUUID } from 'node:crypto';
import {
  createSqlPublicationOutboxDeliveryRepository,
  type PublicationDeliveryFailureClassification,
  type PublicationNotice,
  type PublicationOutboxDeliveryRepository,
} from '../../../db/src/publication-outbox-delivery.js';
import { withPostgresTransactionalSqlExecutor } from '../../../db/src/postgres-sql-executor.js';
import type { TransactionalSqlExecutor } from '../../../db/src/sql.js';
import {
  noOpPublicationOutboxDeliveryTelemetry,
  PUBLICATION_OUTBOX_DELIVERY_EVENT_NAME,
  type PublicationOutboxDeliveryTelemetryCounts,
  type PublicationOutboxDeliveryTelemetryRecord,
  type PublicationOutboxDeliveryTelemetrySink,
} from '../layers/l5-evaluation-monitoring/publication-outbox-delivery-telemetry.js';
import { isValidHyperdriveConnectionString } from './public-event-list-runtime.js';

const deliveryRole = 'waspada_l4_publication_outbox_delivery';
const sinkTimeoutMs = 5_000;

export interface PublicationNoticeSink {
  /** The sink must durably deduplicate logical effects by the supplied outbox ID. */
  deliver(
    notice: PublicationNotice,
    idempotencyKey: string,
    signal: AbortSignal,
  ): Promise<unknown>;
}

export interface PublicationOutboxDeliveryRuntimeConfiguration {
  readonly datasetMode?: string;
  readonly relayEnabled?: string;
  readonly deliveryWriterConnectionString?: string;
}

export type PublicationOutboxDeliveryTransactionalSqlExecutorRunner = <Result>(
  connectionString: string,
  operation: (executor: TransactionalSqlExecutor) => Promise<Result>,
) => Promise<Result>;

export type PublicationOutboxDeliveryRepositoryFactory = (
  executor: TransactionalSqlExecutor,
) => PublicationOutboxDeliveryRepository;

export interface PublicationOutboxDeliveryRuntimeDependencies {
  readonly sink?: PublicationNoticeSink;
  readonly withTransactionalSqlExecutor?: PublicationOutboxDeliveryTransactionalSqlExecutorRunner;
  readonly createRepository?: PublicationOutboxDeliveryRepositoryFactory;
  readonly clock?: () => number;
  readonly reservationKey?: () => string;
  readonly timeoutMs?: number;
  readonly telemetry?: PublicationOutboxDeliveryTelemetrySink;
}

export interface PublicationOutboxDeliveryPassResult {
  readonly outcome: 'completed';
  readonly counts: PublicationOutboxDeliveryTelemetryCounts;
}

export interface PublicationOutboxDeliveryRuntime {
  relay(evaluatedAtMs: number): Promise<PublicationOutboxDeliveryPassResult>;
}

export type PublicationOutboxDeliveryRuntimeErrorCode = 'INVALID_EVALUATION_TIME' | 'DELIVERY_FAILED';

export class PublicationOutboxDeliveryRuntimeError extends Error {
  constructor(readonly code: PublicationOutboxDeliveryRuntimeErrorCode) {
    super(code === 'INVALID_EVALUATION_TIME'
      ? 'The publication delivery evaluation time is invalid.'
      : 'The publication notice delivery pass could not be completed.');
    this.name = 'PublicationOutboxDeliveryRuntimeError';
  }
}

/** Builds an exact-live relay only when its explicit gate, SQL connection, and injected sink exist. */
export function createPublicationOutboxDeliveryRuntime(
  configuration: PublicationOutboxDeliveryRuntimeConfiguration,
  dependencies: PublicationOutboxDeliveryRuntimeDependencies = {},
): PublicationOutboxDeliveryRuntime | undefined {
  if (configuration.datasetMode !== 'live'
    || configuration.relayEnabled !== 'true'
    || !isValidHyperdriveConnectionString(configuration.deliveryWriterConnectionString)
    || !dependencies.sink) {
    return undefined;
  }

  const connectionString = configuration.deliveryWriterConnectionString;
  const sink = dependencies.sink;
  const withTransactionalSqlExecutor = dependencies.withTransactionalSqlExecutor
    ?? withPostgresTransactionalSqlExecutor;
  const repositoryFactory = dependencies.createRepository ?? createSqlPublicationOutboxDeliveryRepository;
  const clock = dependencies.clock ?? Date.now;
  const createReservationKey = dependencies.reservationKey ?? randomUUID;
  const timeout = dependencies.timeoutMs ?? sinkTimeoutMs;
  const telemetry = dependencies.telemetry ?? noOpPublicationOutboxDeliveryTelemetry;

  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 30_000) return undefined;

  return {
    async relay(evaluatedAtMs): Promise<PublicationOutboxDeliveryPassResult> {
      const telemetryStartedAt = readTelemetryClock();
      const counts: MutableCounts = emptyCounts();
      let result: PublicationOutboxDeliveryPassResult | undefined;
      let failure: PublicationOutboxDeliveryRuntimeError | undefined;

      try {
        validateEvaluationTime(evaluatedAtMs);
        const reservationKey = validateReservationKey(createReservationKey());
        await withTransactionalSqlExecutor(connectionString, (executor) => withDeliveryRole(executor, async () => {
          const repository = repositoryFactory(executor);
          const page = await repository.claimPage({ evaluatedAtMs, reservationKey });
          if (page.outcome === 'conflict') throw new Error('reservation conflict');
          if (page.attempts.length > 20) throw new Error('page exceeded maximum size');
          counts.reserved = page.attempts.length;

          for (const attempt of page.attempts) {
            const sinkResult = await deliverWithTimeout(sink, attempt.notice, attempt.outboxId, timeout);
            const completedAtMs = readClock(clock);
            const resultInput = sinkResult.outcome === 'delivered'
              ? { attemptId: attempt.attemptId, outcome: 'delivered' as const, completedAtMs }
              : {
                attemptId: attempt.attemptId,
                outcome: sinkResult.outcome,
                completedAtMs,
                failureClassification: sinkResult.failureClassification,
              };
            const stored = await repository.recordResult(resultInput);
            if (stored.outcome === 'conflict') throw new Error('delivery result conflict');

            if (sinkResult.outcome === 'delivered') counts.delivered += 1;
            else if (sinkResult.outcome === 'retryable_failure') counts.retryableFailures += 1;
            else counts.permanentFailures += 1;
          }
        }));
        result = { outcome: 'completed', counts: { ...counts } };
      } catch (error) {
        const code = error instanceof PublicationOutboxDeliveryRuntimeError
          ? error.code
          : isInvalidEvaluationTime(evaluatedAtMs) ? 'INVALID_EVALUATION_TIME' : 'DELIVERY_FAILED';
        failure = new PublicationOutboxDeliveryRuntimeError(code);
      }

      recordTelemetry(telemetry, failure === undefined ? 'completed' : 'failed', telemetryStartedAt, counts);
      if (failure) throw failure;
      return result!;
    },
  };
}

interface MutableCounts {
  reserved: number;
  delivered: number;
  retryableFailures: number;
  permanentFailures: number;
}

type SinkResult =
  | { readonly outcome: 'delivered' }
  | {
    readonly outcome: 'retryable_failure';
    readonly failureClassification: Extract<PublicationDeliveryFailureClassification, 'timeout' | 'transient' | 'unknown'>;
  }
  | { readonly outcome: 'permanent_failure'; readonly failureClassification: 'permanent_rejection' };

function emptyCounts(): MutableCounts {
  return { reserved: 0, delivered: 0, retryableFailures: 0, permanentFailures: 0 };
}

async function deliverWithTimeout(
  sink: PublicationNoticeSink,
  notice: PublicationNotice,
  idempotencyKey: string,
  timeoutMs: number,
): Promise<SinkResult> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutResult = new Promise<SinkResult>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve({ outcome: 'retryable_failure', failureClassification: 'timeout' });
    }, timeoutMs);
  });

  const delivery = Promise.resolve()
    .then(() => sink.deliver(closedNotice(notice), idempotencyKey, controller.signal))
    .then(validateSinkResult, (): SinkResult => ({ outcome: 'retryable_failure', failureClassification: 'unknown' }));

  try {
    return await Promise.race([delivery, timeoutResult]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function closedNotice(notice: PublicationNotice): PublicationNotice {
  return {
    eventId: notice.eventId,
    eventVersion: notice.eventVersion,
    eventKind: 'event_version_published',
    occurredAt: notice.occurredAt,
  };
}

function validateSinkResult(value: unknown): SinkResult {
  if (!isObject(value)) return { outcome: 'retryable_failure', failureClassification: 'unknown' };
  if (hasExactKeys(value, ['outcome']) && value.outcome === 'delivered') return { outcome: 'delivered' };
  if (hasExactKeys(value, ['outcome', 'failureClassification'])
    && value.outcome === 'retryable_failure'
    && (value.failureClassification === 'timeout' || value.failureClassification === 'transient'
      || value.failureClassification === 'unknown')) {
    return { outcome: 'retryable_failure', failureClassification: value.failureClassification };
  }
  if (hasExactKeys(value, ['outcome', 'failureClassification'])
    && value.outcome === 'permanent_failure' && value.failureClassification === 'permanent_rejection') {
    return { outcome: 'permanent_failure', failureClassification: 'permanent_rejection' };
  }
  return { outcome: 'retryable_failure', failureClassification: 'unknown' };
}

async function withDeliveryRole<Result>(
  executor: TransactionalSqlExecutor,
  operation: () => Promise<Result>,
): Promise<Result> {
  let primaryFailure: { readonly error: unknown } | undefined;
  let result: Result | undefined;
  let completed = false;

  try {
    await executor.execute(`SET ROLE ${deliveryRole}`);
    result = await operation();
    completed = true;
  } catch (error) {
    primaryFailure = { error };
  } finally {
    try {
      await executor.execute('RESET ROLE');
    } catch (error) {
      if (primaryFailure === undefined) primaryFailure = { error };
    }
  }

  if (primaryFailure !== undefined) throw primaryFailure.error;
  if (!completed) throw new Error('delivery role operation did not complete');
  return result as Result;
}

function recordTelemetry(
  telemetry: PublicationOutboxDeliveryTelemetrySink,
  outcome: 'completed' | 'failed',
  startedAt: number | undefined,
  counts: MutableCounts,
): void {
  try {
    const finishedAt = readTelemetryClock();
    const duration = startedAt === undefined || finishedAt === undefined ? 0 : finishedAt - startedAt;
    const record: PublicationOutboxDeliveryTelemetryRecord = {
      eventName: PUBLICATION_OUTBOX_DELIVERY_EVENT_NAME,
      outcome,
      durationMs: Number.isFinite(duration) && duration >= 0 ? duration : 0,
      counts: { ...counts },
    };
    telemetry.record(record);
  } catch {
    // Telemetry validation and sink failures cannot change a completed or failed relay pass.
  }
}

function validateEvaluationTime(value: unknown): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || Math.abs(value) > 8.64e15
    || !Number.isFinite(new Date(value).getTime())) {
    throw new PublicationOutboxDeliveryRuntimeError('INVALID_EVALUATION_TIME');
  }
}

function isInvalidEvaluationTime(value: unknown): boolean {
  try {
    validateEvaluationTime(value);
    return false;
  } catch {
    return true;
  }
}

function validateReservationKey(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value)) throw new Error();
  return value;
}

function readClock(clock: () => number): number {
  const value = clock();
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || Math.abs(value) > 8.64e15
    || !Number.isFinite(new Date(value).getTime())) throw new Error();
  return value;
}

function readTelemetryClock(): number | undefined {
  try {
    const value = Date.now();
    return Number.isFinite(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => key in value);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
