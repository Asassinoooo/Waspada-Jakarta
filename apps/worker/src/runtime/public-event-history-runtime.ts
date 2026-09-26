import { createPublicEventHistoryDisclosureRepository } from "../../../db/src/public-event-history-disclosure.js";
import { createPublicEventHistoryRepository } from "../../../db/src/public-event-history.js";
import { withPostgresSqlExecutor } from "../../../db/src/postgres-sql-executor.js";
import type { SqlExecutor } from "../../../db/src/sql.js";
import {
  createPublicEventHistoryProjectionService,
  PublicEventHistoryProjectionServiceError,
  PUBLIC_EVENT_HISTORY_PROJECTION_LIMITS,
  type PublicEventHistoryProjectionService,
} from "../layers/l4-application-integration/public-event-history-projection-service.js";
import { isValidHyperdriveConnectionString } from "./public-event-list-runtime.js";

const eventIdentifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;
const maxEventIdentifierLength = 128;
const defaultPageSize = 20;
const maxCursorLength = 2_048;
const maxDatabaseInteger = 2_147_483_647;

export interface PublicEventHistoryRuntimeConfiguration {
  readonly datasetMode?: string;
  readonly connectionString?: string;
}

export type PublicEventHistorySqlExecutorRunner = <Result>(
  connectionString: string,
  operation: (executor: SqlExecutor) => Promise<Result>,
) => Promise<Result>;

export interface PublicEventHistoryRuntimeDependencies {
  /** Test seam for a fake SQL executor; production uses the PostgreSQL adapter. */
  readonly withSqlExecutor?: PublicEventHistorySqlExecutorRunner;
}

/**
 * Builds the read-only live history service only for exact live mode and a
 * valid injected Hyperdrive connection string. The SQL client stays lazy until
 * the event ID and history query have both been validated.
 */
export function createPublicEventHistoryRuntime(
  configuration: PublicEventHistoryRuntimeConfiguration,
  dependencies: PublicEventHistoryRuntimeDependencies = {},
): PublicEventHistoryProjectionService | undefined {
  if (configuration.datasetMode !== "live"
    || !isValidHyperdriveConnectionString(configuration.connectionString)) {
    return undefined;
  }

  const connectionString = configuration.connectionString;
  const withSqlExecutor = dependencies.withSqlExecutor ?? withPostgresSqlExecutor;
  return {
    read(eventId, query) {
      if (!isValidEventIdentifier(eventId)) {
        throw new PublicEventHistoryProjectionServiceError("INVALID_EVENT_ID");
      }
      const options = parseHistoryQuery(query);

      return withSqlExecutor(connectionString, async (executor) => {
        const candidates = createPublicEventHistoryRepository(executor);
        const disclosures = createPublicEventHistoryDisclosureRepository(executor);
        const projection = createPublicEventHistoryProjectionService({
          candidates,
          disclosures,
        });
        return projection.read(eventId, options);
      });
    },
  };
}

function parseHistoryQuery(value: unknown): {
  readonly limit: number;
  readonly afterVersion: number | null;
} {
  if (value !== undefined && !(value instanceof URLSearchParams)) failInvalidPage();
  const search = value ?? new URLSearchParams();
  const allowed = new Set(["cursor", "limit"]);
  for (const key of search.keys()) {
    if (!allowed.has(key)) failInvalidPage();
  }

  const cursors = search.getAll("cursor");
  const limits = search.getAll("limit");
  if (cursors.length > 1 || limits.length > 1) failInvalidPage();

  const rawLimit = limits[0];
  let limit = defaultPageSize;
  if (rawLimit !== undefined) {
    if (!/^(0|[1-9]\d*)$/u.test(rawLimit)) failInvalidPage();
    const parsedLimit = Number(rawLimit);
    if (!Number.isSafeInteger(parsedLimit)
      || parsedLimit < 1
      || parsedLimit > PUBLIC_EVENT_HISTORY_PROJECTION_LIMITS.maxPageSize) {
      failInvalidPage();
    }
    limit = parsedLimit;
  }

  const rawCursor = cursors[0];
  let afterVersion: number | null = null;
  if (rawCursor !== undefined) {
    if (rawCursor.length > maxCursorLength || !/^[1-9]\d*$/u.test(rawCursor)) failInvalidPage();
    const parsedCursor = Number(rawCursor);
    if (!Number.isSafeInteger(parsedCursor) || parsedCursor > maxDatabaseInteger) failInvalidPage();
    afterVersion = parsedCursor;
  }

  return { limit, afterVersion };
}

function isValidEventIdentifier(value: unknown): value is string {
  return typeof value === "string"
    && value.length <= maxEventIdentifierLength
    && eventIdentifierPattern.test(value);
}

function failInvalidPage(): never {
  throw new PublicEventHistoryProjectionServiceError("INVALID_PAGE");
}
