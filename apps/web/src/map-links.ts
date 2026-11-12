/*
 * Hash helpers for the map home (UI-V2-B). `#peta?event=<id>`, and the legacy
 * `#jelajah?event=<id>`, select one published event. The parsing and building
 * functions are pure. copyText only touches the clipboard when it exists.
 */

export const MAP_HOME_HASH = "#peta";
const MAX_EVENT_ID_LENGTH = 256;

/** Event id from the `event` query of a hash, or null when absent or empty. */
export function parseEventIdFromHash(hash: string): string | null {
  const queryStart = hash.indexOf("?");
  if (queryStart === -1) return null;
  const value = new URLSearchParams(hash.slice(queryStart + 1)).get("event");
  if (value === null) return null;
  const eventId = value.trim();
  return eventId.length > 0 && eventId.length <= MAX_EVENT_ID_LENGTH ? eventId : null;
}

export function buildEventHash(eventId: string): string {
  return `${MAP_HOME_HASH}?event=${encodeURIComponent(eventId)}`;
}

/** Absolute link to one event on the map, built from the current page address. */
export function eventShareUrl(eventId: string, currentHref: string): string {
  return new URL(buildEventHash(eventId), currentHref).href;
}

/** Copies text when the browser exposes the clipboard. Resolves false otherwise, never throws. */
export async function copyText(text: string): Promise<boolean> {
  try {
    const clipboard = typeof navigator !== "undefined" ? navigator.clipboard : undefined;
    if (!clipboard || typeof clipboard.writeText !== "function") return false;
    await clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
