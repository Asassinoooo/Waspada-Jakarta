import { useEffect, useState } from "react";
import { notificationPermission, NOTIFY_CHANGE_EVENT, NOTIFY_STORAGE_KEY, readNotifyEnabled } from "./notify-settings.js";
import { browserPreferencesStorage, loadPreferences, PREFERENCES_STORAGE_KEY, type BriefingInterests } from "./preferences-store.js";

function hasAnyInterest(interests: BriefingInterests): boolean {
  return interests.categories.length > 0 || interests.places.length > 0 || interests.services.length > 0
    || interests.institutions.length > 0 || interests.audiences.length > 0;
}

/** The interests to notify for, or null when notifications must not run (off, no permission, no saved interests). */
function readActiveInterests(): BriefingInterests | null {
  const storage = browserPreferencesStorage();
  if (!readNotifyEnabled(storage) || notificationPermission() !== "granted") return null;
  const saved = loadPreferences(storage);
  if (saved.status !== "loaded" || !hasAnyInterest(saved.interests)) return null;
  return saved.interests;
}

/**
 * NOTIFY-01: runs the "Area saya" notifier for the whole app while this tab is open. It follows the setting, the
 * permission and the saved interests, and restarts when any of them change in this tab or another one.
 */
export function useInterestNotifications(): void {
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const bump = () => setRevision((current) => current + 1);
    const onStorage = (event: StorageEvent) => {
      if (event.key === null || event.key === NOTIFY_STORAGE_KEY || event.key === PREFERENCES_STORAGE_KEY) bump();
    };
    window.addEventListener(NOTIFY_CHANGE_EVENT, bump);
    window.addEventListener("storage", onStorage);
    // Interests saved in this tab fire no storage event; leaving the page re-reads them.
    window.addEventListener("hashchange", bump);
    return () => {
      window.removeEventListener(NOTIFY_CHANGE_EVENT, bump);
      window.removeEventListener("hashchange", bump);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const interests = readActiveInterests();
    if (interests === null) return;
    // PERF-09: the notifier code loads only when notifications are on, permitted and have saved interests.
    let stopped = false;
    let notifier: { start(): void; stop(): void } | null = null;
    void import("./interest-notifications.js").then(({ createInterestNotifier, showBrowserNotification }) => {
      if (stopped) return;
      notifier = createInterestNotifier({ interests, notify: showBrowserNotification });
      notifier.start();
    });
    return () => {
      stopped = true;
      notifier?.stop();
    };
  }, [revision]);
}
