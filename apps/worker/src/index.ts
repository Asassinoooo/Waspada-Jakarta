import { createPublicEventListRuntime } from "./runtime/public-event-list-runtime.js";
import { createPublicEventDetailRuntime } from "./runtime/public-event-detail-runtime.js";
import { createPublicEventHistoryRuntime } from "./runtime/public-event-history-runtime.js";
import { createPublicEventGeoJSONRuntime } from "./runtime/public-event-geojson-runtime.js";
import {
  handlePublicApiRequest,
  isPublicEventDetailPath,
  isPublicEventHistoryPath,
  type WorkerEnvironment,
} from "./layers/l4-application-integration/api.js";
import { consoleTelemetry } from "./layers/l5-evaluation-monitoring/telemetry.js";

export default {
  async fetch(request: Request, env: WorkerEnvironment): Promise<Response> {
    const url = new URL(request.url);
    const eventListPageService =
      env.DATASET_MODE === "live"
        && request.method === "GET"
        && url.pathname === "/api/v1/events"
        ? await createPublicEventListRuntime({
          datasetMode: env.DATASET_MODE,
          connectionString: env.HYPERDRIVE?.connectionString,
          cursorHmacKeyHex: env.PUBLIC_EVENT_LIST_CURSOR_HMAC_KEY_HEX,
        })
        : undefined;
    const eventDetailProjectionService =
      env.DATASET_MODE === "live"
        && request.method === "GET"
        && isPublicEventDetailPath(url.pathname)
        ? createPublicEventDetailRuntime({
          datasetMode: env.DATASET_MODE,
          connectionString: env.HYPERDRIVE?.connectionString,
        })
        : undefined;
    const eventHistoryProjectionService =
      env.DATASET_MODE === "live"
        && request.method === "GET"
        && isPublicEventHistoryPath(url.pathname)
        ? createPublicEventHistoryRuntime({
          datasetMode: env.DATASET_MODE,
          connectionString: env.HYPERDRIVE?.connectionString,
        })
        : undefined;
    const eventGeoJSONRuntime =
      env.DATASET_MODE === "live"
        && request.method === "GET"
        && url.pathname === "/api/v1/events.geojson"
        ? createPublicEventGeoJSONRuntime({
          datasetMode: env.DATASET_MODE,
          connectionString: env.HYPERDRIVE?.connectionString,
        })
        : undefined;

    return handlePublicApiRequest(
      request,
      env,
      consoleTelemetry,
      eventListPageService,
      eventDetailProjectionService,
      eventHistoryProjectionService,
      eventGeoJSONRuntime,
    );
  },
};
