import { withPostgresSqlExecutor } from "../../../db/src/postgres-sql-executor.js";
import { createPublicEventListRepository } from "../../../db/src/public-event-list.js";
import { createPublicEventSnapshotRepository } from "../../../db/src/public-event-snapshot.js";
import { createPublicProjectionLookupRepository } from "../../../db/src/public-projection-lookups.js";
import type { SqlExecutor } from "../../../db/src/sql.js";
import { createPublicEventListCursorCodec } from "../layers/l4-application-integration/public-event-list-cursor.js";
import {
  createPublicEventListPageService,
  type PublicEventListPageService,
} from "../layers/l4-application-integration/public-event-list-page-service.js";
import {
  createPublicEventListProjectionService,
  type PublicEventListProjectionService,
} from "../layers/l4-application-integration/public-event-list-projection-service.js";
import { createPublicEventProjectionService } from "../layers/l4-application-integration/public-event-projection-service.js";

const cursorSecretPattern = /^[a-fA-F0-9]{64}$/u;
const maxConnectionStringLength = 4_096;

export interface PublicEventListRuntimeConfiguration {
  readonly datasetMode?: string;
  readonly connectionString?: string;
  readonly cursorHmacKeyHex?: string;
}

export type PublicEventListSqlExecutorRunner = <Result>(
  connectionString: string,
  operation: (executor: SqlExecutor) => Promise<Result>,
) => Promise<Result>;

export interface PublicEventListRuntimeDependencies {
  /** Test seam for a fake client/executor; production uses the PostgreSQL adapter. */
  readonly withSqlExecutor?: PublicEventListSqlExecutorRunner;
  readonly now?: () => number;
}

/**
 * Builds the live list page service only for exact live mode with both required
 * configuration values. The database adapter remains lazy until the accepted
 * page service has parsed the query and authenticated any incoming cursor.
 */
export async function createPublicEventListRuntime(
  configuration: PublicEventListRuntimeConfiguration,
  dependencies: PublicEventListRuntimeDependencies = {},
): Promise<PublicEventListPageService | undefined> {
  if (configuration.datasetMode !== "live"
    || !isValidHyperdriveConnectionString(configuration.connectionString)
    || !isValidCursorSecret(configuration.cursorHmacKeyHex)) {
    return undefined;
  }

  let key: CryptoKey;
  try {
    key = await globalThis.crypto.subtle.importKey(
      "raw",
      decodeHex(configuration.cursorHmacKeyHex),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign", "verify"],
    );
  } catch {
    return undefined;
  }

  const connectionString = configuration.connectionString;
  const withSqlExecutor = dependencies.withSqlExecutor ?? withPostgresSqlExecutor;
  const projection: PublicEventListProjectionService = {
    read(request) {
      return withSqlExecutor(connectionString, async (executor) => {
        const candidates = createPublicEventListRepository(executor);
        const snapshots = createPublicEventSnapshotRepository(executor);
        const lookups = createPublicProjectionLookupRepository(executor);
        const eventProjection = createPublicEventProjectionService({ snapshots, lookups });
        const listProjection = createPublicEventListProjectionService({
          candidates,
          projections: eventProjection,
        });
        return listProjection.read(request);
      });
    },
  };
  const cursorCodec = createPublicEventListCursorCodec({
    key,
    now: dependencies.now ?? Date.now,
  });

  return createPublicEventListPageService({ projection, cursorCodec });
}

export function isValidHyperdriveConnectionString(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0
    || value.length > maxConnectionStringLength || value.trim() !== value) {
    return false;
  }

  try {
    const parsed = new URL(value);
    return (parsed.protocol === "postgres:" || parsed.protocol === "postgresql:")
      && parsed.hostname.length > 0
      && parsed.username.length > 0
      && parsed.password.length > 0
      && parsed.pathname.length > 1
      && parsed.hash.length === 0;
  } catch {
    return false;
  }
}

function isValidCursorSecret(value: unknown): value is string {
  return typeof value === "string" && cursorSecretPattern.test(value);
}

function decodeHex(value: string): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(new ArrayBuffer(value.length / 2));
  for (let offset = 0; offset < value.length; offset += 2) {
    bytes[offset / 2] = Number.parseInt(value.slice(offset, offset + 2), 16);
  }
  return bytes;
}
