import type { EventPage, PublicContext } from "@waspada/worker/public-contracts";

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(path, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`API request failed with status ${response.status}`);
  return (await response.json()) as T;
}

export function getPublicContext() {
  return getJson<PublicContext>("/api/v1/context");
}

export function listEvents() {
  return getJson<EventPage>("/api/v1/events");
}
