import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  withPostgresSqlExecutor,
  withPostgresTransactionalSqlExecutor,
} from '../src/postgres-sql-executor.js';

interface PersonRow {
  readonly id: string;
  readonly name: string;
}

interface FakeQueryResult {
  readonly rows: readonly object[];
  readonly command?: string;
  readonly rowCount?: number | null;
}

interface FakeClient {
  connect(): Promise<void>;
  query<Row extends object = Record<string, unknown>>(
    statement: string,
    parameters?: unknown[],
  ): Promise<{ readonly rows: readonly Row[] }>;
  end(): Promise<void>;
}

interface FakeClientOptions {
  readonly connect?: () => Promise<void>;
  readonly query?: (statement: string, parameters?: unknown[]) => Promise<FakeQueryResult>;
  readonly end?: () => Promise<void>;
}

const CONNECTION_STRING = 'postgresql://db.example.invalid:5432/waspada';

describe('request-scoped node-postgres SqlExecutor adapter', () => {
  it('forwards typed query rows and unchanged parameter values, returning only rows', async () => {
    const events: string[] = [];
    const connectionStrings: string[] = [];
    const marker = { source: 'synthetic' };
    const observedAt = new Date('2026-09-27T00:00:00.000Z');
    const parameters = [17, null, marker, observedAt] as const;
    const rows: readonly PersonRow[] = [{ id: 'person-1', name: 'Ayu' }];
    const queryCalls: { statement: string; parameters?: unknown[] }[] = [];
    const driverResult: FakeQueryResult = { rows, command: 'SELECT', rowCount: 1 };

    const result = await withPostgresSqlExecutor(
      CONNECTION_STRING,
      async (executor) => {
        const typedRows = await executor.query<PersonRow>(
          'SELECT id, name FROM people WHERE id = $1 AND marker = $2 AND at = $3 AND observed_at = $4',
          parameters,
        );
        const typedName: string = typedRows.rows[0]!.name;
        assert.equal(typedName, 'Ayu');
        return typedRows;
      },
      fakeClientFactory({
        query: async (statement, values) => {
          events.push('query');
          queryCalls.push({ statement, ...(values === undefined ? {} : { parameters: values }) });
          return driverResult;
        },
      }, events, connectionStrings),
    );

    assert.deepEqual(connectionStrings, [CONNECTION_STRING]);
    assert.deepEqual(events, ['connect', 'query', 'end']);
    assert.equal(queryCalls.length, 1);
    assert.equal(queryCalls[0]!.statement,
      'SELECT id, name FROM people WHERE id = $1 AND marker = $2 AND at = $3 AND observed_at = $4');
    assert.deepEqual(queryCalls[0]!.parameters, [...parameters]);
    assert.notStrictEqual(queryCalls[0]!.parameters, parameters);
    assert.strictEqual(queryCalls[0]!.parameters?.[2], marker);
    assert.strictEqual(queryCalls[0]!.parameters?.[3], observedAt);
    assert.strictEqual(result.rows, rows);
    assert.deepEqual(Object.keys(result), ['rows']);
  });

  it('awaits execute, discards driver metadata, and closes after success', async () => {
    const events: string[] = [];
    const connectionStrings: string[] = [];
    let resolveQuery!: () => void;
    let signalQueryStarted!: () => void;
    const queryGate = new Promise<void>((resolve) => { resolveQuery = resolve; });
    const queryStarted = new Promise<void>((resolve) => { signalQueryStarted = resolve; });

    const result = await withPostgresSqlExecutor(
      CONNECTION_STRING,
      async (executor) => {
        let executeFinished = false;
        const executePromise = executor.execute('DELETE FROM temporary_fixture').then(() => {
          executeFinished = true;
        });
        await queryStarted;
        await Promise.resolve();
        assert.equal(executeFinished, false);
        resolveQuery();
        await executePromise;
      },
      fakeClientFactory({
        query: async () => {
          events.push('query:start');
          signalQueryStarted();
          await queryGate;
          events.push('query:complete');
          return { rows: [], command: 'DELETE', rowCount: 3 };
        },
      }, events, connectionStrings),
    );

    assert.equal(result, undefined);
    assert.deepEqual(events, ['connect', 'query:start', 'query:complete', 'end']);
    assert.deepEqual(connectionStrings, [CONNECTION_STRING]);
  });

  it('closes after connection failure and preserves that error if close also fails', async () => {
    const events: string[] = [];
    const connectionStrings: string[] = [];
    const connectionError = new Error('synthetic connection failure');
    const closeError = new Error('synthetic close failure');
    let operationCalled = false;

    await assert.rejects(
      withPostgresSqlExecutor(
        CONNECTION_STRING,
        async () => {
          operationCalled = true;
        },
        fakeClientFactory({
          connect: async () => { throw connectionError; },
          end: async () => { throw closeError; },
        }, events, connectionStrings),
      ),
      (error: unknown) => error === connectionError,
    );

    assert.equal(operationCalled, false);
    assert.deepEqual(connectionStrings, [CONNECTION_STRING]);
    assert.deepEqual(events, ['connect', 'end']);
  });

  it('closes after query failure and preserves the query error', async () => {
    const events: string[] = [];
    const connectionStrings: string[] = [];
    const queryError = new Error('synthetic query failure');

    await assert.rejects(
      withPostgresSqlExecutor(
        CONNECTION_STRING,
        async (executor) => executor.query('SELECT failing_fixture'),
        fakeClientFactory({
          query: async () => { events.push('query'); throw queryError; },
        }, events, connectionStrings),
      ),
      (error: unknown) => error === queryError,
    );

    assert.deepEqual(events, ['connect', 'query', 'end']);
  });

  it('preserves an operation failure when cleanup fails too', async () => {
    const events: string[] = [];
    const connectionStrings: string[] = [];
    const operationError = new Error('synthetic operation failure');
    const closeError = new Error('synthetic close failure');

    await assert.rejects(
      withPostgresSqlExecutor(
        CONNECTION_STRING,
        async () => { events.push('operation'); throw operationError; },
        fakeClientFactory({
          end: async () => { throw closeError; },
        }, events, connectionStrings),
      ),
      (error: unknown) => error === operationError,
    );

    assert.deepEqual(events, ['connect', 'operation', 'end']);
  });

  it('rejects a successful operation when client cleanup fails', async () => {
    const events: string[] = [];
    const connectionStrings: string[] = [];
    const closeError = new Error('synthetic close failure');

    await assert.rejects(
      withPostgresSqlExecutor(
        CONNECTION_STRING,
        async () => { events.push('operation'); return 'completed'; },
        fakeClientFactory({
          end: async () => { throw closeError; },
        }, events, connectionStrings),
      ),
      (error: unknown) => error === closeError,
    );

    assert.deepEqual(events, ['connect', 'operation', 'end']);
  });
});

function fakeClientFactory(
  options: FakeClientOptions,
  events: string[],
  connectionStrings: string[],
): (connectionString: string) => FakeClient {
  return (connectionString) => {
    connectionStrings.push(connectionString);
    return {
      async connect() {
        events.push('connect');
        await options.connect?.();
      },
      async query<Row extends object = Record<string, unknown>>(statement: string, parameters?: unknown[]) {
        const result = options.query
          ? await options.query(statement, parameters)
          : { rows: [] };
        return result as unknown as { readonly rows: readonly Row[] };
      },
      async end() {
        events.push('end');
        await options.end?.();
      },
    };
  };
}


describe('request-scoped node-postgres TransactionalSqlExecutor adapter', () => {
  it('uses one client and issues transaction statements in order only when requested', async () => {
    const events: string[] = [];
    const connectionStrings: string[] = [];
    const queryCalls: { readonly statement: string; readonly parameters?: unknown[] }[] = [];
    const marker = { source: 'synthetic' };
    const parameters = [marker, 17] as const;
    const rows: readonly PersonRow[] = [{ id: 'person-2', name: 'Bima' }];

    const result = await withPostgresTransactionalSqlExecutor(
      CONNECTION_STRING,
      async (executor) => {
        const before = await executor.query('SELECT before_transaction');
        assert.deepEqual(before.rows, []);

        const name = await executor.transaction(async (transaction) => {
          const people = await transaction.query<PersonRow>(
            'SELECT id, name FROM people WHERE marker = $1 AND id = $2',
            parameters,
          );
          const typedName: string = people.rows[0]!.name;
          await transaction.execute('UPDATE people SET seen = true');
          return typedName;
        });

        await executor.execute('SELECT after_transaction');
        return name;
      },
      fakeClientFactory({
        query: async (statement, values) => {
          events.push('sql:' + statement);
          queryCalls.push({ statement, ...(values === undefined ? {} : { parameters: values }) });
          return statement.startsWith('SELECT id, name') ? { rows } : { rows: [] };
        },
      }, events, connectionStrings),
    );

    assert.equal(result, 'Bima');
    assert.deepEqual(connectionStrings, [CONNECTION_STRING]);
    assert.deepEqual(events, [
      'connect',
      'sql:SELECT before_transaction',
      'sql:BEGIN',
      'sql:SELECT id, name FROM people WHERE marker = $1 AND id = $2',
      'sql:UPDATE people SET seen = true',
      'sql:COMMIT',
      'sql:SELECT after_transaction',
      'end',
    ]);
    assert.deepEqual(queryCalls.map((call) => call.statement), [
      'SELECT before_transaction',
      'BEGIN',
      'SELECT id, name FROM people WHERE marker = $1 AND id = $2',
      'UPDATE people SET seen = true',
      'COMMIT',
      'SELECT after_transaction',
    ]);
    assert.deepEqual(queryCalls[2]!.parameters, [...parameters]);
    assert.notStrictEqual(queryCalls[2]!.parameters, parameters);
    assert.strictEqual(queryCalls[2]!.parameters?.[0], marker);
  });

  it('rolls back work failures and preserves the original error if rollback fails', async () => {
    const events: string[] = [];
    const connectionStrings: string[] = [];
    const workError = new Error('synthetic transaction work failure');
    const rollbackError = new Error('synthetic rollback failure');

    await assert.rejects(
      withPostgresTransactionalSqlExecutor(
        CONNECTION_STRING,
        (executor) => executor.transaction(async (transaction) => {
          await transaction.query('SELECT before_failure');
          throw workError;
        }),
        fakeClientFactory({
          query: async (statement) => {
            events.push('sql:' + statement);
            if (statement === 'ROLLBACK') throw rollbackError;
            return { rows: [] };
          },
        }, events, connectionStrings),
      ),
      (error: unknown) => error === workError,
    );

    assert.deepEqual(connectionStrings, [CONNECTION_STRING]);
    assert.deepEqual(events, [
      'connect',
      'sql:BEGIN',
      'sql:SELECT before_failure',
      'sql:ROLLBACK',
      'end',
    ]);
  });

  it('attempts rollback after commit failure and preserves it over rollback and cleanup failures', async () => {
    const events: string[] = [];
    const connectionStrings: string[] = [];
    const commitError = new Error('synthetic commit failure');
    const rollbackError = new Error('synthetic rollback failure');
    const closeError = new Error('synthetic close failure');

    await assert.rejects(
      withPostgresTransactionalSqlExecutor(
        CONNECTION_STRING,
        (executor) => executor.transaction(async (transaction) => {
          await transaction.execute('UPDATE fixture SET value = 1');
          return 'uncommitted';
        }),
        fakeClientFactory({
          query: async (statement) => {
            events.push('sql:' + statement);
            if (statement === 'COMMIT') throw commitError;
            if (statement === 'ROLLBACK') throw rollbackError;
            return { rows: [] };
          },
          end: async () => { throw closeError; },
        }, events, connectionStrings),
      ),
      (error: unknown) => error === commitError,
    );

    assert.deepEqual(connectionStrings, [CONNECTION_STRING]);
    assert.deepEqual(events, [
      'connect',
      'sql:BEGIN',
      'sql:UPDATE fixture SET value = 1',
      'sql:COMMIT',
      'sql:ROLLBACK',
      'end',
    ]);
  });

  it('skips the operation after connect failure and attempts cleanup', async () => {
    const events: string[] = [];
    const connectionStrings: string[] = [];
    const connectError = new Error('synthetic connection failure');
    const closeError = new Error('synthetic close failure');
    let operationCalled = false;

    await assert.rejects(
      withPostgresTransactionalSqlExecutor(
        CONNECTION_STRING,
        async () => { operationCalled = true; },
        fakeClientFactory({
          connect: async () => { throw connectError; },
          end: async () => { throw closeError; },
        }, events, connectionStrings),
      ),
      (error: unknown) => error === connectError,
    );

    assert.equal(operationCalled, false);
    assert.deepEqual(connectionStrings, [CONNECTION_STRING]);
    assert.deepEqual(events, ['connect', 'end']);
  });

  it('surfaces cleanup failure after a successful outer operation', async () => {
    const events: string[] = [];
    const connectionStrings: string[] = [];
    const closeError = new Error('synthetic close failure');

    await assert.rejects(
      withPostgresTransactionalSqlExecutor(
        CONNECTION_STRING,
        (executor) => executor.transaction(async () => 'committed'),
        fakeClientFactory({
          query: async (statement) => {
            events.push('sql:' + statement);
            return { rows: [] };
          },
          end: async () => { throw closeError; },
        }, events, connectionStrings),
      ),
      (error: unknown) => error === closeError,
    );

    assert.deepEqual(connectionStrings, [CONNECTION_STRING]);
    assert.deepEqual(events, ['connect', 'sql:BEGIN', 'sql:COMMIT', 'end']);
  });
});
