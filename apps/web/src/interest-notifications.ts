/**
 * NOTIFY-01 (owner, 23 Nov 2026): browser notifications for "Area saya", only while a Waspada tab is open.
 *
 * Interests never leave this browser. The notifier reads the public updates feed, reads each changed event's public
 * detail, and matches it on the device with the same rule as the Pembaruan page (matchPublicUpdate: a chosen category,
 * or a chosen place, service, institution or audience named in the event's scope). There is no service worker, no Web
 * Push and no server-side subscription: closing the tab stops the notifications.
 *
 * The cursor lives in memory, so it never touches the Pembaruan page's stored cursor. The first cycle takes a baseline
 * and notifies nothing, so opening the page never replays old events.
 */
import { ApiHttpError, getEventDetailWithSignal, getPublicUpdates, type PublicUpdatePage } from "./api-client.js";
import type { BriefingInterests, PreferencesStorage } from "./preferences-store.js";
import { hydrateAndMatchUpdates, type MatchedPublicUpdate, type UpdateCenterScheduler } from "./UpdatesCenter.js";

export const NOTIFY_STORAGE_KEY = "waspada-jakarta:notify:v1";
/** Fired on window when the setting changes in this tab, so the app-level notifier can start or stop. */
export const NOTIFY_CHANGE_EVENT = "waspada:notify-change";
export const NOTIFY_POLL_INTERVAL_MS = 60_000;
/** At most this many single notifications per cycle; more matches become one summary notification. */
export const NOTIFY_MAX_PER_CYCLE = 3;
const NOTIFY_MAX_PAGES_PER_CYCLE = 5;
const NOTIFY_PAGE_SIZE = 20;

export const NOTIFY_EMERGENCY_LINE = "Bukan layanan darurat. Darurat: 112.";

export type NotifyPermission = "unsupported" | "default" | "granted" | "denied";

export function notificationPermission(): NotifyPermission {
  if (typeof window === "undefined" || typeof window.Notification === "undefined") return "unsupported";
  const value = window.Notification.permission;
  return value === "granted" || value === "denied" ? value : "default";
}

export function readNotifyEnabled(storage: PreferencesStorage | null | undefined): boolean {
  try {
    return storage?.getItem(NOTIFY_STORAGE_KEY) === "on";
  } catch {
    return false;
  }
}

/** Saves the setting and tells this tab's notifier. Returns false when the browser refuses the write. */
export function writeNotifyEnabled(storage: PreferencesStorage | null | undefined, enabled: boolean): boolean {
  try {
    if (!storage) return false;
    if (enabled) storage.setItem(NOTIFY_STORAGE_KEY, "on");
    else storage.removeItem(NOTIFY_STORAGE_KEY);
  } catch {
    return false;
  }
  if (typeof window !== "undefined") window.dispatchEvent(new Event(NOTIFY_CHANGE_EVENT));
  return true;
}

export interface NotificationContent {
  readonly title: string;
  readonly body: string;
  /** One notification per event: a later version replaces the earlier one. */
  readonly tag: string;
  /** The map deep link opened by a click, or null for the summary. */
  readonly eventId: string | null;
}

/** Plain, factual text. It names the change and the event, never says an area is safe, and carries the 112 line. */
export function notificationContent(match: MatchedPublicUpdate): NotificationContent {
  const title = match.change.change_type === "published" ? "Laporan baru di area Anda" : "Laporan diperbarui di area Anda";
  return {
    title,
    body: match.event.title + "\n" + NOTIFY_EMERGENCY_LINE,
    tag: "waspada-" + match.event.event_id,
    eventId: match.event.event_id,
  };
}

export function summaryContent(extraCount: number): NotificationContent {
  return {
    title: extraCount + " laporan lain di area Anda",
    body: "Buka Waspada Jakarta untuk melihat semuanya.\n" + NOTIFY_EMERGENCY_LINE,
    tag: "waspada-summary",
    eventId: null,
  };
}

export interface InterestNotifierOptions {
  interests: BriefingInterests;
  notify: (content: NotificationContent) => void;
  getUpdates?: (cursor: string | undefined, signal: AbortSignal) => Promise<PublicUpdatePage>;
  getDetail?: (eventId: string, signal: AbortSignal) => Promise<unknown>;
  scheduler?: UpdateCenterScheduler;
}

export interface InterestNotifier {
  start(): void;
  stop(): void;
  /** One poll. Exposed for tests; the scheduler calls it every minute. */
  cycle(): Promise<void>;
}

const browserScheduler: UpdateCenterScheduler = {
  setTimeout: (callback, delayMs) => window.setTimeout(callback, delayMs),
  clearTimeout: (handle) => window.clearTimeout(handle as number),
};

export function createInterestNotifier(options: InterestNotifierOptions): InterestNotifier {
  const readUpdates = options.getUpdates ?? ((cursor, signal) => getPublicUpdates(cursor, signal));
  const readDetail = options.getDetail ?? ((eventId, signal) => getEventDetailWithSignal(eventId, signal));
  const scheduler = options.scheduler ?? browserScheduler;
  const notified = new Set<string>();
  let cursor: string | null = null;
  let active = false;
  let timer: unknown = null;
  let controller: AbortController | null = null;
  let running: Promise<void> | null = null;

  async function poll(signal: AbortSignal): Promise<void> {
    if (cursor === null) {
      const baseline = await readUpdates(undefined, signal);
      cursor = baseline.next_cursor;
      return;
    }
    const fresh: MatchedPublicUpdate[] = [];
    for (let page = 0; page < NOTIFY_MAX_PAGES_PER_CYCLE; page += 1) {
      let result: PublicUpdatePage;
      try {
        result = await readUpdates(cursor, signal);
      } catch (error) {
        // An expired cursor starts a new baseline: changes in the gap are not replayed as notifications.
        if (error instanceof ApiHttpError && error.status === 410) {
          cursor = null;
          return;
        }
        throw error;
      }
      const changes = result.items.filter((change) => change.change_type !== "retracted");
      if (changes.length > 0) {
        const matches = await hydrateAndMatchUpdates(changes, options.interests, readDetail, signal);
        for (const match of matches) {
          const key = match.change.event_id + ":" + match.change.version;
          if (notified.has(key)) continue;
          notified.add(key);
          fresh.push(match);
        }
      }
      cursor = result.next_cursor;
      if (result.items.length < NOTIFY_PAGE_SIZE) break;
    }
    // One notification per event, newest version first, then at most NOTIFY_MAX_PER_CYCLE of them.
    const byEvent = new Map<string, MatchedPublicUpdate>();
    for (const match of fresh) {
      const current = byEvent.get(match.event.event_id);
      if (!current || match.change.version > current.change.version) byEvent.set(match.event.event_id, match);
    }
    const ordered = [...byEvent.values()];
    for (const match of ordered.slice(0, NOTIFY_MAX_PER_CYCLE)) options.notify(notificationContent(match));
    if (ordered.length > NOTIFY_MAX_PER_CYCLE) options.notify(summaryContent(ordered.length - NOTIFY_MAX_PER_CYCLE));
  }

  function schedule(delayMs: number) {
    if (!active) return;
    if (timer !== null) scheduler.clearTimeout(timer);
    timer = scheduler.setTimeout(() => {
      timer = null;
      void cycle().finally(() => schedule(NOTIFY_POLL_INTERVAL_MS));
    }, delayMs);
  }

  function cycle(): Promise<void> {
    if (running) return running;
    const current = new AbortController();
    controller = current;
    running = poll(current.signal)
      // A failed poll is quiet: the next minute tries again. Notifications are a convenience, not a feed of record.
      .catch(() => undefined)
      .finally(() => {
        running = null;
        if (controller === current) controller = null;
      });
    return running;
  }

  return {
    start() {
      if (active) return;
      active = true;
      void cycle().finally(() => schedule(NOTIFY_POLL_INTERVAL_MS));
    },
    stop() {
      active = false;
      if (timer !== null) scheduler.clearTimeout(timer);
      timer = null;
      controller?.abort();
      controller = null;
    },
    cycle,
  };
}

/** Shows one browser notification. A click focuses the tab and opens the event on the map. */
export function showBrowserNotification(content: NotificationContent): void {
  if (notificationPermission() !== "granted") return;
  try {
    const notification = new window.Notification(content.title, { body: content.body, tag: content.tag, lang: "id" });
    notification.onclick = () => {
      window.focus();
      window.location.hash = content.eventId === null ? "#pembaruan" : "#peta?event=" + encodeURIComponent(content.eventId);
      notification.close();
    };
  } catch {
    // Some browsers (Android Chrome) allow notifications only from a service worker. The setting then does nothing.
  }
}
