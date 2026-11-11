import { useState } from "react";

// Theme preference for the whole page: "system" follows prefers-color-scheme,
// "light" and "dark" pin data-theme on <html>. Stored per browser only.
export type ThemePreference = "system" | "light" | "dark";

const STORAGE_KEY = "waspada-theme";
const ORDER: readonly ThemePreference[] = ["system", "light", "dark"];
const LABEL: Record<ThemePreference, string> = { system: "Sistem", light: "Terang", dark: "Gelap" };

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

/** Applies the stored preference before the first render to avoid a theme flash. */
export function applyStoredTheme(): void {
  if (typeof window === "undefined" || typeof document === "undefined") return;
  applyTheme(readStoredTheme());
}

export function ThemeToggle() {
  const [theme, setTheme] = useState<ThemePreference>(() =>
    typeof window === "undefined" ? "system" : readStoredTheme(),
  );

  function cycleTheme() {
    const next = ORDER[(ORDER.indexOf(theme) + 1) % ORDER.length] ?? "system";
    setTheme(next);
    applyTheme(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Storage can be blocked (private mode, disabled site data); the choice still applies for this visit.
    }
  }

  return (
    <button
      type="button"
      className="theme-toggle"
      onClick={cycleTheme}
      aria-label={`Tema tampilan, saat ini ${LABEL[theme]}`}
      title="Ganti tema tampilan: Sistem, Terang, Gelap"
    >
      <span className="theme-toggle__label">Tema: {LABEL[theme]}</span>
    </button>
  );
}
