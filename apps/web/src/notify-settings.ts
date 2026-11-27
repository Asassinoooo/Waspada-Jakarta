// PERF-09: the NOTIFY-01 setting and permission helpers, kept apart from the notifier so the app shell can check the
// setting without loading the notifier (interest-notifications.ts), which loads only when notifications are on.
import type { PreferencesStorage } from "./preferences-store.js";

export const NOTIFY_STORAGE_KEY = "waspada-jakarta:notify:v1";
/** Fired on window when the setting changes in this tab, so the app-level notifier can start or stop. */
export const NOTIFY_CHANGE_EVENT = "waspada:notify-change";
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
