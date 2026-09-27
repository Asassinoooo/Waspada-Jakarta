import type {
  EventDetail,
  EventPage,
  HistoryPage,
  PublicContext,
  PublicFeatureCollection,
} from "../../contracts/public-api.js";
import { noConfiguredSources } from "../l1-data-knowledge/source-status.js";
import {
  PublicEventListPageServiceError,
  type PublicEventListPageService,
} from "./public-event-list-page-service.js";
import {
  API_REQUEST_EVENT_NAME,
  noOpTelemetry,
  type TelemetrySink,
} from "../l5-evaluation-monitoring/telemetry.js";
import { PublicReadModel, QueryValidationError } from "./public-read-model.js";
import { readPublicGeoJSONQuery } from "./public-geojson-query.js";
import {
  PublicEventDetailProjectionServiceError,
  type PublicEventDetailProjectionService,
} from "./public-event-detail-projection-service.js";
import {
  PublicEventHistoryProjectionServiceError,
  type PublicEventHistoryProjectionService,
} from "./public-event-history-projection-service.js";
import type { PublicEventGeoJSONRuntime } from "../../runtime/public-event-geojson-runtime.js";

export interface WorkerEnvironment {
  DATASET_MODE?: string;
  HYPERDRIVE?: { readonly connectionString?: string };
  PUBLIC_EVENT_LIST_CURSOR_HMAC_KEY_HEX?: string;
}

const readModel = new PublicReadModel(noConfiguredSources);

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

function geoJSONResponse(body: PublicFeatureCollection) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      "content-type": "application/geo+json",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

function apiError(code: string, message: string, status: number) {
  return jsonResponse({ code, message, request_id: crypto.randomUUID() }, status);
}

function eventRoute(pathname: string): { kind: "detail" | "history"; encodedId: string } | null {
  const historyMatch = /^\/api\/v1\/events\/([^/]*)\/history$/.exec(pathname);
  if (historyMatch) return { kind: "history", encodedId: historyMatch[1] ?? "" };

  const detailMatch = /^\/api\/v1\/events\/([^/]*)$/.exec(pathname);
  if (detailMatch) return { kind: "detail", encodedId: detailMatch[1] ?? "" };

  return null;
}

export function isPublicEventDetailPath(pathname: string): boolean {
  return eventRoute(pathname)?.kind === "detail";
}

export function isPublicEventHistoryPath(pathname: string): boolean {
  return eventRoute(pathname)?.kind === "history";
}

function decodeEventId(encodedId: string): string {
  let eventId: string;
  try {
    eventId = decodeURIComponent(encodedId);
  } catch {
    throw new QueryValidationError("event_id is invalid");
  }

  const length = Array.from(eventId).length;
  if (
    length < 1 ||
    length > 128 ||
    eventId.includes("/") ||
    eventId.includes("\\") ||
    /[\u0000-\u001f\u007f]/u.test(eventId)
  ) {
    throw new QueryValidationError("event_id is invalid");
  }
  return eventId;
}

export async function handlePublicApiRequest(
  request: Request,
  env: WorkerEnvironment,
  telemetry: TelemetrySink = noOpTelemetry,
  eventListPageService?: PublicEventListPageService,
  eventDetailProjectionService?: PublicEventDetailProjectionService,
  eventHistoryProjectionService?: PublicEventHistoryProjectionService,
  eventGeoJSONRuntime?: PublicEventGeoJSONRuntime,
) {
  const startedAt = Date.now();
  const url = new URL(request.url);
  const selectedEventRoute = eventRoute(url.pathname);
  const selectedGeoJSONRoute = url.pathname === "/api/v1/events.geojson";
  const route =
    url.pathname === "/api/v1/context"
      ? "context"
      : url.pathname === "/api/v1/events" || selectedEventRoute !== null || selectedGeoJSONRoute
        ? "events"
        : "other";
  let response: Response | undefined;

  try {
    const exactLiveListRoute =
      env.DATASET_MODE === "live" && url.pathname === "/api/v1/events";
    const exactLiveDetailRoute =
      env.DATASET_MODE === "live" && selectedEventRoute?.kind === "detail";
    const exactLiveHistoryRoute =
      env.DATASET_MODE === "live" && selectedEventRoute?.kind === "history";
    const exactLiveGeoJSONRoute = env.DATASET_MODE === "live" && selectedGeoJSONRoute;
    if (request.method !== "GET") {
      response = apiError("INVALID_REQUEST", "Only read-only GET requests are available.", 405);
    } else if (env.DATASET_MODE
      && env.DATASET_MODE !== "demo"
      && env.DATASET_MODE !== "live") {
      response = apiError(
        "TEMPORARILY_UNAVAILABLE",
        "This runtime only contains the synthetic demo dataset.",
        503,
      );
    } else if (env.DATASET_MODE === "live"
      && !exactLiveListRoute
      && !exactLiveDetailRoute
      && !exactLiveHistoryRoute
      && !exactLiveGeoJSONRoute) {
      response = apiError(
        "TEMPORARILY_UNAVAILABLE",
        "This runtime only contains the synthetic demo dataset.",
        503,
      );
    } else if (exactLiveListRoute && !eventListPageService) {
      response = apiError("TEMPORARILY_UNAVAILABLE", "The public read could not be completed.", 503);
    } else if (exactLiveDetailRoute && !eventDetailProjectionService) {
      response = apiError("TEMPORARILY_UNAVAILABLE", "The public read could not be completed.", 503);
    } else if (exactLiveHistoryRoute && !eventHistoryProjectionService) {
      response = apiError("TEMPORARILY_UNAVAILABLE", "The public read could not be completed.", 503);
    } else if (route === "context") {
      const context: PublicContext = readModel.context("demo");
      response = jsonResponse(context);
    } else if (route === "events") {
      if (selectedGeoJSONRoute) {
        readPublicGeoJSONQuery(url.searchParams);
        if (env.DATASET_MODE === "live") {
          if (!eventGeoJSONRuntime) {
            response = apiError("TEMPORARILY_UNAVAILABLE", "The public read could not be completed.", 503);
          } else {
            response = geoJSONResponse(await eventGeoJSONRuntime.read(url.searchParams));
          }
        } else {
          const featureCollection: PublicFeatureCollection = readModel.geoJSON();
          response = geoJSONResponse(featureCollection);
        }
      } else if (url.pathname === "/api/v1/events") {
        const page: EventPage = eventListPageService
          ? await eventListPageService.read(url.searchParams)
          : readModel.events(url.searchParams);
        response = jsonResponse(page);
      } else if (selectedEventRoute) {
        const eventId = decodeEventId(selectedEventRoute.encodedId);
        if (selectedEventRoute.kind === "detail") {
          if (env.DATASET_MODE === "live") {
            if (!isValidLiveDetailEventId(eventId)) {
              throw new QueryValidationError("event_id is invalid");
            }
            const result = await eventDetailProjectionService!.read(eventId);
            response = result.kind === "found"
              ? jsonResponse(result.detail)
              : apiError("NOT_FOUND", "The requested public route was not found.", 404);
          } else {
            const detail: EventDetail | null = readModel.detail(eventId);
            response = detail
              ? jsonResponse(detail)
              : apiError("NOT_FOUND", "The requested public route was not found.", 404);
          }
        } else if (env.DATASET_MODE === "live") {
          const result = await eventHistoryProjectionService!.read(eventId, url.searchParams);
          response = result.kind === "found"
            ? jsonResponse(result.page)
            : apiError("NOT_FOUND", "The requested public route was not found.", 404);
        } else {
          const history: HistoryPage | null = readModel.history(eventId, url.searchParams);
          response = history
            ? jsonResponse(history)
            : apiError("NOT_FOUND", "The requested public route was not found.", 404);
        }
      } else {
        response = apiError("NOT_FOUND", "The requested public route was not found.", 404);
      }
    } else {
      response = apiError("NOT_FOUND", "The requested public route was not found.", 404);
    }
  } catch (error) {
    response = error instanceof PublicEventDetailProjectionServiceError
      && error.code === "INVALID_EVENT_ID"
      ? apiError("INVALID_REQUEST", "event_id is invalid", 400)
      : error instanceof PublicEventHistoryProjectionServiceError
        ? error.code === "INVALID_EVENT_ID"
          ? apiError("INVALID_REQUEST", "event_id is invalid", 400)
          : error.code === "INVALID_PAGE"
            ? apiError("INVALID_REQUEST", "The public event history request is invalid.", 400)
            : apiError("TEMPORARILY_UNAVAILABLE", "The public read could not be completed.", 500)
        : error instanceof PublicEventListPageServiceError
        ? error.code === "INVALID_REQUEST"
          ? apiError("INVALID_REQUEST", "The public event list request is invalid.", 400)
          : apiError("TEMPORARILY_UNAVAILABLE", "The public read could not be completed.", 500)
        : error instanceof QueryValidationError
          ? apiError("INVALID_REQUEST", error.message, 400)
          : apiError("TEMPORARILY_UNAVAILABLE", "The public read could not be completed.", 500);
  } finally {
    try {
      const elapsedMs = Date.now() - startedAt;
      telemetry.record({
        eventName: API_REQUEST_EVENT_NAME,
        route,
        status: response?.status ?? 500,
        durationMs: Number.isFinite(elapsedMs) ? Math.max(0, elapsedMs) : 0,
      });
    } catch {
      // Request telemetry is best-effort and must never change the API response.
    }
  }

  return response ?? apiError("TEMPORARILY_UNAVAILABLE", "The public read could not be completed.", 500);
}

function isValidLiveDetailEventId(value: string): boolean {
  return value.length <= 128 && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value);
}
