import type { SqlExecutor } from './sql.js';

export const PUBLIC_EVENT_SNAPSHOT_LIMITS = Object.freeze({
  eventIdLength: 200,
  events: 500,
  impacts: 100,
  totalImpacts: 10_000,
});

export interface PublicEventSnapshotImpact {
  readonly eventId: string;
  readonly eventVersion: number;
  readonly impactId: string;
  readonly impactVersion: number;
  /** Untrusted schema 2.0 input for the next Layer 4 validation boundary. */
  readonly recordJson: unknown;
}

export interface PublicEventSnapshot {
  readonly datasetKind: 'live';
  readonly eventId: string;
  readonly eventVersion: number;
  /** Untrusted schema 2.0 input for the next Layer 4 validation boundary. */
  readonly recordJson: unknown;
  readonly impacts: readonly PublicEventSnapshotImpact[];
}

export type PublicEventSnapshotReadResult =
  | { readonly kind: 'found'; readonly snapshot: PublicEventSnapshot }
  | { readonly kind: 'missing' };

export interface PublicEventSnapshotRepository {
  /** Reads the current published live event from the configured public views. */
  read(eventId: unknown): Promise<PublicEventSnapshotReadResult>;
  /** Reads distinct current published live events with one bounded set read. */
  readMany(eventIds: unknown): Promise<readonly PublicEventSnapshot[]>;
}

export type PublicEventSnapshotErrorCode =
  | 'INVALID_EVENT_ID'
  | 'RESULT_INVALID'
  | 'IMPACT_LIMIT_EXCEEDED'
  | 'TOTAL_IMPACT_LIMIT_EXCEEDED'
  | 'READ_FAILED';

const errorMessages: Record<PublicEventSnapshotErrorCode, string> = {
  INVALID_EVENT_ID: 'The public event identifier is invalid.',
  RESULT_INVALID: 'The public event snapshot could not be validated.',
  IMPACT_LIMIT_EXCEEDED: 'The public event snapshot exceeds its impact limit.',
  TOTAL_IMPACT_LIMIT_EXCEEDED: 'The public event snapshots exceed their impact limit.',
  READ_FAILED: 'The public event snapshot could not be read.',
};

/** Bounded error messages never include SQL, identifiers, or database record content. */
export class PublicEventSnapshotError extends Error {
  constructor(readonly code: PublicEventSnapshotErrorCode) {
    super(errorMessages[code]);
    this.name = 'PublicEventSnapshotError';
  }
}

interface EventVersionRow {
  readonly dataset_kind: unknown;
  readonly event_id: unknown;
  readonly version: unknown;
  readonly record_json: unknown;
}

interface EventImpactRow {
  readonly dataset_kind: unknown;
  readonly event_id: unknown;
  readonly event_version: unknown;
  readonly impact_id: unknown;
  readonly impact_version: unknown;
  readonly record_json: unknown;
}

const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u;
const maxDatabaseInteger = 2_147_483_647;
const impactOverflowProbe = PUBLIC_EVENT_SNAPSHOT_LIMITS.impacts + 1;
const totalImpactOverflowProbe = PUBLIC_EVENT_SNAPSHOT_LIMITS.totalImpacts + 1;
const eventOverflowProbe = PUBLIC_EVENT_SNAPSHOT_LIMITS.events + 1;

export function createPublicEventSnapshotRepository(
  executor: SqlExecutor,
): PublicEventSnapshotRepository {
  return {
    async read(eventId: unknown): Promise<PublicEventSnapshotReadResult> {
      if (!isIdentifier(eventId)) fail('INVALID_EVENT_ID');

      const eventRows = await queryRows<EventVersionRow>(
        executor,
        `SELECT event.dataset_kind, event.event_id, event.version, event.record_json
         FROM waspada.public_event_versions AS event
         WHERE event.dataset_kind = 'live'
           AND event.event_id = $1
         ORDER BY event.version DESC
         LIMIT 2`,
        [eventId],
      );
      if (eventRows.length === 0) return { kind: 'missing' };
      if (eventRows.length !== 1) fail('RESULT_INVALID');

      const event = validateEventRow(eventRows[0], eventId);
      const impactRows = await queryRows<EventImpactRow>(
        executor,
        `SELECT impact.dataset_kind, impact.event_id, impact.event_version,
                impact.impact_id, impact.impact_version, impact.record_json
         FROM waspada.public_event_impacts AS impact
         WHERE impact.dataset_kind = 'live'
           AND impact.event_id = $1
           AND impact.event_version = $2
         ORDER BY impact.impact_id, impact.impact_version
         LIMIT $3`,
        [event.eventId, event.eventVersion, impactOverflowProbe],
      );
      if (impactRows.length > PUBLIC_EVENT_SNAPSHOT_LIMITS.impacts) {
        fail('IMPACT_LIMIT_EXCEEDED');
      }

      const impacts = impactRows.map((row) => validateImpactRow(row, event));
      impacts.sort((left, right) => compareStrings(left.impactId, right.impactId)
        || left.impactVersion - right.impactVersion);

      return {
        kind: 'found',
        snapshot: {
          datasetKind: 'live',
          eventId: event.eventId,
          eventVersion: event.eventVersion,
          recordJson: event.recordJson,
          impacts,
        },
      };
    },

    async readMany(eventIds: unknown): Promise<readonly PublicEventSnapshot[]> {
      const requestedEventIds = validateEventIds(eventIds);
      if (requestedEventIds.length === 0) return [];

      const eventRows = await queryRows<EventVersionRow>(
        executor,
        `SELECT event.dataset_kind, event.event_id, event.version, event.record_json
         FROM waspada.public_event_versions AS event
         WHERE event.dataset_kind = 'live'
           AND event.event_id = ANY($1::text[])
         ORDER BY event.event_id COLLATE "C" ASC, event.version DESC
         LIMIT $2`,
        [requestedEventIds, eventOverflowProbe],
      );
      if (eventRows.length > PUBLIC_EVENT_SNAPSHOT_LIMITS.events) fail('RESULT_INVALID');

      const requested = new Set(requestedEventIds);
      const eventById = new Map<string, {
        readonly eventId: string;
        readonly eventVersion: number;
        readonly recordJson: unknown;
      }>();
      for (const row of eventRows) {
        if (!isRecord(row) || typeof row.event_id !== 'string' || !requested.has(row.event_id)) {
          fail('RESULT_INVALID');
        }
        const event = validateEventRow(row, row.event_id);
        if (!requested.has(event.eventId) || eventById.has(event.eventId)) fail('RESULT_INVALID');
        eventById.set(event.eventId, event);
      }
      if (eventById.size === 0) return [];

      const events = [...eventById.values()].sort((left, right) => compareStrings(left.eventId, right.eventId));
      const impactRows = await queryRows<EventImpactRow>(
        executor,
        `SELECT impact.dataset_kind, impact.event_id, impact.event_version,
                impact.impact_id, impact.impact_version, impact.record_json
         FROM waspada.public_event_impacts AS impact
         JOIN unnest($1::text[], $2::integer[]) AS requested(event_id, event_version)
           ON requested.event_id = impact.event_id
          AND requested.event_version = impact.event_version
         WHERE impact.dataset_kind = 'live'
         ORDER BY impact.event_id COLLATE "C" ASC, impact.impact_id COLLATE "C" ASC,
                  impact.impact_version ASC
         LIMIT $3`,
        [
          events.map(({ eventId }) => eventId),
          events.map(({ eventVersion }) => eventVersion),
          totalImpactOverflowProbe,
        ],
      );
      if (impactRows.length > PUBLIC_EVENT_SNAPSHOT_LIMITS.totalImpacts) {
        fail('TOTAL_IMPACT_LIMIT_EXCEEDED');
      }

      const impactsByEventId = new Map<string, PublicEventSnapshotImpact[]>();
      const impactIdentities = new Set<string>();
      for (const event of events) impactsByEventId.set(event.eventId, []);
      for (const row of impactRows) {
        const eventId = isRecord(row) ? row.event_id : undefined;
        if (typeof eventId !== 'string') fail('RESULT_INVALID');
        const event = eventById.get(eventId);
        if (event === undefined) fail('RESULT_INVALID');
        const impact = validateImpactRow(row, event);
        const identity = JSON.stringify([impact.eventId, impact.eventVersion, impact.impactId, impact.impactVersion]);
        if (impactIdentities.has(identity)) fail('RESULT_INVALID');
        impactIdentities.add(identity);
        const eventImpacts = impactsByEventId.get(event.eventId);
        if (eventImpacts === undefined) fail('RESULT_INVALID');
        eventImpacts.push(impact);
        if (eventImpacts.length > PUBLIC_EVENT_SNAPSHOT_LIMITS.impacts) fail('IMPACT_LIMIT_EXCEEDED');
      }

      return events.map((event) => ({
        datasetKind: 'live',
        eventId: event.eventId,
        eventVersion: event.eventVersion,
        recordJson: event.recordJson,
        impacts: (impactsByEventId.get(event.eventId) ?? []).sort((left, right) =>
          compareStrings(left.impactId, right.impactId) || left.impactVersion - right.impactVersion),
      }));
    },
  };
}

function validateEventRow(value: unknown, requestedEventId: string): {
  readonly eventId: string;
  readonly eventVersion: number;
  readonly recordJson: unknown;
} {
  if (!hasExactKeys(value, ['dataset_kind', 'event_id', 'version', 'record_json'])
    || value.dataset_kind !== 'live'
    || !isIdentifier(value.event_id)
    || value.event_id !== requestedEventId
    || !isPositiveDatabaseInteger(value.version)
    || !isJsonObject(value.record_json)) {
    fail('RESULT_INVALID');
  }
  return {
    eventId: value.event_id,
    eventVersion: value.version,
    recordJson: value.record_json,
  };
}

function validateEventIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > PUBLIC_EVENT_SNAPSHOT_LIMITS.events) {
    fail('INVALID_EVENT_ID');
  }
  const eventIds: string[] = [];
  const seen = new Set<string>();
  for (const eventId of value) {
    if (!isIdentifier(eventId) || seen.has(eventId)) fail('INVALID_EVENT_ID');
    seen.add(eventId);
    eventIds.push(eventId);
  }
  eventIds.sort(compareStrings);
  return eventIds;
}

function validateImpactRow(value: unknown, event: {
  readonly eventId: string;
  readonly eventVersion: number;
}): PublicEventSnapshotImpact {
  if (!hasExactKeys(value, [
    'dataset_kind', 'event_id', 'event_version', 'impact_id', 'impact_version', 'record_json',
  ])
    || value.dataset_kind !== 'live'
    || value.event_id !== event.eventId
    || value.event_version !== event.eventVersion
    || !isIdentifier(value.impact_id)
    || !isPositiveDatabaseInteger(value.impact_version)
    || !isJsonObject(value.record_json)) {
    fail('RESULT_INVALID');
  }
  return {
    eventId: event.eventId,
    eventVersion: event.eventVersion,
    impactId: value.impact_id,
    impactVersion: value.impact_version,
    recordJson: value.record_json,
  };
}

async function queryRows<Row extends object>(
  executor: SqlExecutor,
  statement: string,
  parameters: readonly unknown[],
): Promise<readonly Row[]> {
  let result: unknown;
  try {
    result = await executor.query<Row>(statement, parameters);
  } catch {
    fail('READ_FAILED');
  }
  if (!isRecord(result) || !Array.isArray(result.rows)) fail('RESULT_INVALID');
  return result.rows as readonly Row[];
}

function isIdentifier(value: unknown): value is string {
  return typeof value === 'string'
    && value.length <= PUBLIC_EVENT_SNAPSHOT_LIMITS.eventIdLength
    && identifierPattern.test(value);
}

function isPositiveDatabaseInteger(value: unknown): value is number {
  return Number.isSafeInteger(value)
    && (value as number) >= 1
    && (value as number) <= maxDatabaseInteger;
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function fail(code: PublicEventSnapshotErrorCode): never {
  throw new PublicEventSnapshotError(code);
}
