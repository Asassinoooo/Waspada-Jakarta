import type { EventPage, PublicContext } from "../../contracts/public-api.js";
import { noConfiguredSources } from "../l1-data-knowledge/source-status.js";
import { noOpTelemetry } from "../l5-evaluation-monitoring/telemetry.js";
import { PublicReadModel, QueryValidationError } from "./public-read-model.js";

export interface WorkerEnvironment {
  DATASET_MODE?: string;
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

function apiError(code: string, message: string, status: number) {
  return jsonResponse({ code, message, request_id: crypto.randomUUID() }, status);
}

export async function handlePublicApiRequest(request: Request, env: WorkerEnvironment) {
  const startedAt = Date.now();
  const url = new URL(request.url);
  const route =
    url.pathname === "/api/v1/context"
      ? "context"
      : url.pathname === "/api/v1/events"
        ? "events"
        : "other";
  let response: Response | undefined;

  try {
    if (request.method !== "GET") {
      response = apiError("INVALID_REQUEST", "Only read-only GET requests are available.", 405);
    } else if (env.DATASET_MODE && env.DATASET_MODE !== "demo") {
      response = apiError(
        "TEMPORARILY_UNAVAILABLE",
        "This runtime only contains the synthetic demo dataset.",
        503,
      );
    } else if (route === "context") {
      const context: PublicContext = readModel.context("demo");
      response = jsonResponse(context);
    } else if (route === "events") {
      const page: EventPage = readModel.events(url.searchParams);
      response = jsonResponse(page);
    } else {
      response = apiError("NOT_FOUND", "The requested public route was not found.", 404);
    }
  } catch (error) {
    response =
      error instanceof QueryValidationError
        ? apiError("INVALID_REQUEST", error.message, 400)
        : apiError("TEMPORARILY_UNAVAILABLE", "The public read could not be completed.", 500);
  } finally {
    noOpTelemetry.record({
      route,
      status: response?.status ?? 500,
      durationMs: Math.max(0, Date.now() - startedAt),
    });
  }

  return response ?? apiError("TEMPORARILY_UNAVAILABLE", "The public read could not be completed.", 500);
}
