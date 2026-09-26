import type { EventDetail, EventPage, HistoryPage, PublicContext } from "@waspada/worker/public-contracts";

export class ApiHttpError extends Error {
  constructor(readonly status: number) {
    super(`Public API request failed with status ${status}`);
    this.name = "ApiHttpError";
  }
}

export type ApiReadState<T> =
  | { eventId: string; status: "loading" | "not-found" | "unavailable" }
  | { eventId: string; status: "loaded"; data: T };

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(path, { headers: { accept: "application/json" } });
  if (!response.ok) throw new ApiHttpError(response.status);
  return (await response.json()) as T;
}

export function getPublicContext() {
  return getJson<PublicContext>("/api/v1/context");
}

export function listEvents() {
  return getJson<EventPage>("/api/v1/events");
}

export function getEventDetail(eventId: string) {
  return getJson<EventDetail>(`/api/v1/events/${encodeURIComponent(eventId)}`);
}

export function getEventHistory(eventId: string) {
  return getJson<HistoryPage>(`/api/v1/events/${encodeURIComponent(eventId)}/history`);
}
