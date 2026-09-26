import { createPublicEventGeometriesRepository } from "../../../db/src/public-event-geometries.js";
import { createPublicEventSnapshotRepository } from "../../../db/src/public-event-snapshot.js";
import { createPublicProjectionLookupRepository } from "../../../db/src/public-projection-lookups.js";
import { withPostgresSqlExecutor } from "../../../db/src/postgres-sql-executor.js";
import type { SqlExecutor } from "../../../db/src/sql.js";
import {
  createPublicEventDetailProjectionService,
  PublicEventDetailProjectionServiceError,
  type PublicEventDetailProjectionService,
} from "../layers/l4-application-integration/public-event-detail-projection-service.js";
import { isValidHyperdriveConnectionString } from "./public-event-list-runtime.js";

const eventIdentifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;
const maxEventIdentifierLength = 128;

export interface PublicEventDetailRuntimeConfiguration {
  readonly datasetMode?: string;
  readonly connectionString?: string;
}

export type PublicEventDetailSqlExecutorRunner = <Result>(
  connectionString: string,
  operation: (executor: SqlExecutor) => Promise<Result>,
) => Promise<Result>;

export interface PublicEventDetailRuntimeDependencies {
  /** Test seam for a fake SQL executor; production uses the PostgreSQL adapter. */
  readonly withSqlExecutor?: PublicEventDetailSqlExecutorRunner;
}

/**
 * Builds the read-only live detail service only for exact live mode and a
 * valid injected Hyperdrive connection string. The SQL client stays lazy until
 * a valid event identifier is read.
 */
export function createPublicEventDetailRuntime(
  configuration: PublicEventDetailRuntimeConfiguration,
  dependencies: PublicEventDetailRuntimeDependencies = {},
): PublicEventDetailProjectionService | undefined {
  if (configuration.datasetMode !== "live"
    || !isValidHyperdriveConnectionString(configuration.connectionString)) {
    return undefined;
  }

  const connectionString = configuration.connectionString;
  const withSqlExecutor = dependencies.withSqlExecutor ?? withPostgresSqlExecutor;
  return {
    async read(eventId) {
      if (!isValidEventIdentifier(eventId)) {
        throw new PublicEventDetailProjectionServiceError("INVALID_EVENT_ID");
      }

      return withSqlExecutor(connectionString, async (executor) => {
        const snapshots = createPublicEventSnapshotRepository(executor);
        const lookups = createPublicProjectionLookupRepository(executor);
        const geometries = createPublicEventGeometriesRepository(executor);
        const projection = createPublicEventDetailProjectionService({
          snapshots,
          lookups,
          geometries,
        });
        return projection.read(eventId);
      });
    },
  };
}

function isValidEventIdentifier(value: unknown): value is string {
  return typeof value === "string"
    && value.length <= maxEventIdentifierLength
    && eventIdentifierPattern.test(value);
}
