// HOSTED-03: one direct, TLS-verified Postgres session for the hosted (Neon) runtime.
//
// Why one connection and not a pg.Pool: several live-path call sites issue BEGIN/COMMIT/ROLLBACK and
// SET ROLE through executor.execute(), not through transaction(). On a pool those statements land on
// different connections. A single session matches the PGlite model that local serve:live already uses.
//
// Known risk, not fixed here: raw BEGIN through execute() (proposal-publication.ts:59,
// event-proposal-writer.ts:143, incident-repository.ts:341) opens a transaction that other flows then
// share, because only transaction() holds the lock. The notice counter below (SQLSTATE 25001/25P01)
// is the tripwire that shows whether this happens against Neon.
//
// Neon Free scales compute to zero and drops idle connections. A dropped connection is cleared on its
// 'error' event, so the process does not crash, and the next call reconnects. A non-SQL failure (for
// example a query_timeout or a silently dead socket) also drops the connection. The failing call throws,
// and the caller's own loop retries it.
import { Client } from "pg";
import type { SqlExecutor, SqlResult, TransactionalSqlExecutor } from "../../apps/db/src/sql.js";
import { safeErrorLabel } from "../live-source-coverage.js";

export class HostedConfigError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "HostedConfigError";
    this.code = code;
  }
}

export interface HostedClientConfig {
  readonly connectionString: string;
  readonly ssl: { readonly rejectUnauthorized: true };
  readonly keepAlive: true;
  readonly connectionTimeoutMillis: number;
  /** Client-side cap, so a silently dead socket cannot hang a query forever. */
  readonly query_timeout: number;
}

// `sslmode` in the URL overrides an explicit ssl option in node-postgres (sslmode=disable turns TLS off),
// so the parameter is removed here and TLS verification is set explicitly.
const ALLOWED_SSLMODES: ReadonlySet<string> = new Set(["require", "verify-ca", "verify-full"]);

/** A SQLSTATE such as 23505 or 42P01: the server answered, so the connection itself is fine. */
function isSqlError(error: unknown): boolean {
  const code = (error as { readonly code?: unknown } | null | undefined)?.code;
  return typeof code === "string" && /^[0-9A-Z]{5}$/u.test(code);
}

/**
 * Validates the URL and returns the client config. Errors carry a fixed code, never the URL or host.
 * Neon's pooled endpoint (PgBouncer, transaction mode) is refused: it breaks session-level SET ROLE and
 * multi-statement transactions, so only the direct endpoint is accepted.
 */
export function buildHostedClientConfig(connectionString: string): HostedClientConfig {
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    throw new HostedConfigError("neon_url_invalid");
  }
  if (url.protocol !== "postgresql:" && url.protocol !== "postgres:") throw new HostedConfigError("neon_url_invalid");
  if (url.hostname.toLowerCase().includes("-pooler")) throw new HostedConfigError("neon_pooler_refused");
  const sslmode = url.searchParams.get("sslmode");
  if (sslmode !== null && !ALLOWED_SSLMODES.has(sslmode)) throw new HostedConfigError("neon_sslmode_refused");
  url.searchParams.delete("sslmode");
  return {
    connectionString: url.toString(),
    ssl: { rejectUnauthorized: true },
    keepAlive: true,
    connectionTimeoutMillis: 20_000,
    query_timeout: 120_000,
  };
}

/** The slice of pg.Client that the session uses. Tests substitute a fake. */
export interface SessionClient {
  connect(): Promise<void>;
  query(text: string, values?: readonly unknown[]): Promise<{ readonly rows: readonly unknown[] }>;
  end(): Promise<void>;
  on(event: "error" | "notice", listener: (value: unknown) => void): unknown;
}

export type SessionClientFactory = (config: HostedClientConfig) => SessionClient;

export const defaultClientFactory: SessionClientFactory = (config) => {
  const client = new Client({ ...config });
  return {
    connect: async () => {
      await client.connect();
    },
    query: async (text, values) => {
      const result = await client.query(text, values === undefined ? undefined : [...values]);
      return { rows: result.rows };
    },
    end: () => client.end(),
    on: (event, listener) => client.on(event, listener),
  };
};

export interface HostedSession {
  readonly executor: TransactionalSqlExecutor;
  /** Count of transaction-state warnings seen (SQLSTATE 25001 or 25P01). A non-zero value means interleaving. */
  transactionStateWarnings(): number;
  close(): Promise<void>;
}

export interface HostedSessionOptions {
  readonly connectionString: string;
  readonly createClient?: SessionClientFactory;
  /** Count-only status lines. Never receives the URL or the error message. */
  readonly log?: (line: string) => void;
}

export function createHostedSession(options: HostedSessionOptions): HostedSession {
  // Throws before any network use if the URL is invalid, is a pooled endpoint, or asks for an unverified TLS mode.
  const config = buildHostedClientConfig(options.connectionString);
  const createClient = options.createClient ?? defaultClientFactory;
  const log = options.log ?? (() => {});

  let current: SessionClient | undefined;
  let pending: Promise<SessionClient> | undefined;
  let closed = false;
  let queue: Promise<unknown> = Promise.resolve();
  let stateWarnings = 0;

  /** Forget a connection that failed for a non-SQL reason, so the next call builds a new one. */
  function dropConnection(client: SessionClient, error: unknown): void {
    if (current !== client) return;
    current = undefined;
    log(`[Hosted] query failed (${safeErrorLabel(error)}); the connection is rebuilt on next use.`);
    client.end().catch(() => undefined);
  }

  async function open(): Promise<SessionClient> {
    const client = createClient(config);
    client.on("error", (error) => {
      log(`[Hosted] database connection ended (${safeErrorLabel(error)}); it reconnects on next use.`);
      if (current === client) current = undefined;
      client.end().catch(() => undefined);
    });
    client.on("notice", (notice) => {
      const code = (notice as { readonly code?: unknown } | null | undefined)?.code;
      if (code === "25001" || code === "25P01") {
        stateWarnings += 1;
        log(`[Hosted] transaction-state warning ${code} (count ${stateWarnings}): statements may have run across flows.`);
      }
    });
    try {
      await client.connect();
    } catch (error) {
      await client.end().catch(() => undefined);
      throw error;
    }
    return client;
  }

  function connection(): Promise<SessionClient> {
    if (closed) return Promise.reject(new Error("hosted_session_closed"));
    if (current !== undefined) return Promise.resolve(current);
    if (pending === undefined) {
      pending = open()
        .then((client) => {
          current = client;
          return client;
        })
        .finally(() => {
          pending = undefined;
        });
    }
    return pending;
  }

  async function runOn<Row extends object>(
    client: SessionClient,
    text: string,
    values?: readonly unknown[],
  ): Promise<SqlResult<Row>> {
    try {
      const result = await client.query(text, values);
      return { rows: result.rows as readonly Row[] };
    } catch (error) {
      if (!isSqlError(error)) dropConnection(client, error);
      throw error;
    }
  }

  async function send<Row extends object>(text: string, values?: readonly unknown[]): Promise<SqlResult<Row>> {
    const client = await connection();
    return runOn<Row>(client, text, values);
  }

  function exclusive<Result>(work: () => Promise<Result>): Promise<Result> {
    const run = queue.then(work);
    queue = run.then(() => undefined, () => undefined);
    return run;
  }

  const executor: TransactionalSqlExecutor = {
    query: <Row extends object>(text: string, values?: readonly unknown[]) =>
      exclusive(() => send<Row>(text, values)),
    execute: (text: string) => exclusive(async () => {
      await send(text);
    }),
    transaction: <Result>(work: (transaction: SqlExecutor) => Promise<Result>) =>
      exclusive(async () => {
        // The transaction is pinned to one connection. If that connection drops mid-way, its statements
        // must fail rather than continue on a new connection outside the transaction.
        const client = await connection();
        await runOn(client, "BEGIN");
        const inside: SqlExecutor = {
          query: <Row extends object>(text: string, values?: readonly unknown[]) => {
            if (current !== client) return Promise.reject(new Error("hosted_transaction_connection_lost"));
            return runOn<Row>(client, text, values);
          },
          execute: async (text: string) => {
            if (current !== client) throw new Error("hosted_transaction_connection_lost");
            await runOn(client, text);
          },
        };
        let result: Result;
        try {
          result = await work(inside);
          await runOn(client, "COMMIT");
        } catch (error) {
          // Send ROLLBACK only on a live connection. If the connection dropped, the server already discarded it.
          if (current === client) await runOn(client, "ROLLBACK").catch(() => undefined);
          throw error;
        }
        return result;
      }),
  };

  return {
    executor,
    transactionStateWarnings: () => stateWarnings,
    async close() {
      closed = true;
      await queue;
      const client = current;
      current = undefined;
      if (client !== undefined) await client.end();
    },
  };
}
