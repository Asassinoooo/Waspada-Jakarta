/**
 * PERF-09c: the small, always-loaded half of the first-visit intro. It holds the storage flag and the open event, so
 * the dialog itself (`OnboardingIntro.tsx`) can stay out of the entry chunk and load only when it will be shown.
 */

export const INTRO_STORAGE_KEY = "waspada-jakarta:intro:v1";
export const INTRO_OPEN_EVENT = "waspada:open-intro";

export interface IntroStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

// If browser storage cannot be read or written, the intro still shows once per page session.
let dismissedThisSession = false;

function defaultStorage(): IntroStorage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function isIntroDone(storage: IntroStorage | null = defaultStorage()): boolean {
  if (dismissedThisSession) return true;
  try {
    return storage?.getItem(INTRO_STORAGE_KEY) === "done";
  } catch {
    return false;
  }
}

export function markIntroDone(storage: IntroStorage | null = defaultStorage()): void {
  dismissedThisSession = true;
  try {
    storage?.setItem(INTRO_STORAGE_KEY, "done");
  } catch {
    // Storage blocked: the module flag above still keeps the intro closed for this page session.
  }
}

/** Test hook: clears the per-session flag so each test starts from a fresh page session. */
export function resetIntroSessionForTests(): void {
  dismissedThisSession = false;
}

/** Opens the intro from anywhere in the app (help page, account menu). */
export function openOnboardingIntro(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(INTRO_OPEN_EVENT));
}

/** The intro opens automatically on the public map only. Admin, review, login, account and source screens never open it. */
export function introAutoOpenFor(screen: string): boolean {
  return screen === "discover";
}
