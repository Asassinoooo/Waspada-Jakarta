import { useSyncExternalStore } from "react";

// Theme preference for the whole page: "system" follows prefers-color-scheme,
// "light" and "dark" pin data-theme on <html>. Stored per browser only.
export type ThemePreference = "system" | "light" | "dark";

const STORAGE_KEY = "waspada-theme";
const ORDER: readonly ThemePreference[] = ["system", "light", "dark"];
export const THEME_LABEL: Record<ThemePreference, string> = { system: "Sistem", light: "Terang", dark: "Gelap" };

// Shared by the header toggle and the phone account menu, so both show one choice.
let current: ThemePreference | null = null;
const listeners = new Set<() => void>();

function readStoredTheme(): ThemePreference {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return stored === "light" || stored === "dark" ? stored : "system";
  } catch {
    return "system";
  }
}

function applyTheme(theme: ThemePreference): void {
  const root = document.documentElement;
  if (theme === "system") root.removeAttribute("data-theme");
  else root.dataset.theme = theme;
}

function currentTheme(): ThemePreference {
  if (current === null) current = typeof window === "undefined" ? "system" : readStoredTheme();
  return current;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Applies the stored preference before the first render to avoid a theme flash. */
export function applyStoredTheme(): void {
  if (typeof window === "undefined" || typeof document === "undefined") return;
  current = readStoredTheme();
  applyTheme(current);
}

export function nextThemePreference(theme: ThemePreference): ThemePreference {
  return ORDER[(ORDER.indexOf(theme) + 1) % ORDER.length] ?? "system";
}

export function setThemePreference(next: ThemePreference): void {
  current = next;
  applyTheme(next);
  try {
    window.localStorage.setItem(STORAGE_KEY, next);
  } catch {
    // Storage can be blocked (private mode, disabled site data); the choice still applies for this visit.
  }
  for (const listener of listeners) listener();
}

export function useThemePreference(): ThemePreference {
  return useSyncExternalStore(subscribe, currentTheme, () => "system");
}

export function ThemeToggle({ className }: { className?: string }) {
  const theme = useThemePreference();
  return (
    <button
      type="button"
      className={className ? `theme-toggle ${className}` : "theme-toggle"}
      onClick={() => setThemePreference(nextThemePreference(theme))}
      aria-label={`Tema tampilan, saat ini ${THEME_LABEL[theme]}`}
      title="Ganti tema tampilan: Sistem, Terang, Gelap"
    >
      <span className="theme-toggle__label">Tema: {THEME_LABEL[theme]}</span>
    </button>
  );
}
