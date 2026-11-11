import { createHash } from "node:crypto";

/**
 * AI-RPM-01 Stage A duplicate key for syndicated news. The same story often
 * arrives from several feeds under different guids and links but with the same
 * headline. Two items share a key when their titles match after NFKC
 * normalisation, lowercasing, and removing punctuation and whitespace.
 */
export const RECENT_ITEM_WINDOW_MS = 48 * 60 * 60 * 1000;

/**
 * A normalised title shorter than this is too generic to identify one story
 * ("Banjir", "Kebakaran"). Such titles never produce a duplicate key.
 */
export const MIN_DEDUPE_TITLE_CHARS = 20;

export function normalizedTitleKey(title: string | null | undefined): string | null {
  if (typeof title !== "string") return null;
  const normalized = title.normalize("NFKC").toLowerCase().replace(/[\p{P}\s]+/gu, "");
  if (Array.from(normalized).length < MIN_DEDUPE_TITLE_CHARS) return null;
  return createHash("sha256").update(normalized, "utf8").digest("hex");
}

/**
 * Recently settled items, keyed by normalised title (process-scoped). A key only
 * blocks a *different* item: the item that settled it may come back (for example
 * a corrected description of the same article) and takes the normal triage path.
 * `identity` is the per-item identity used by the triage cache (sha256 of the
 * source id and the revision key or canonical URL).
 */
export interface RecentItemIndex {
  /** True when a different item identity settled this key inside the window. */
  isDuplicate(key: string, identity: string, nowMs: number): boolean;
  /** Records the identity that settled the key at nowMs, replacing any earlier entry. */
  remember(key: string, identity: string, nowMs: number): void;
}

interface RememberedItem {
  readonly identity: string;
  readonly atMs: number;
}

export function createRecentItemIndex(windowMs: number = RECENT_ITEM_WINDOW_MS): RecentItemIndex {
  const remembered = new Map<string, RememberedItem>();

  function withinWindow(atMs: number, nowMs: number): boolean {
    return Math.abs(nowMs - atMs) <= windowMs;
  }

  return {
    isDuplicate(key, identity, nowMs) {
      const entry = remembered.get(key);
      return entry !== undefined && entry.identity !== identity && withinWindow(entry.atMs, nowMs);
    },
    remember(key, identity, nowMs) {
      for (const [existingKey, entry] of remembered) {
        if (!withinWindow(entry.atMs, nowMs)) remembered.delete(existingKey);
      }
      remembered.set(key, { identity, atMs: nowMs });
    },
  };
}
