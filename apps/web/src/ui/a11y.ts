/*
 * Keyboard and focus helpers shared by the UI primitives (UI-V2-A).
 *
 * The index helpers are pure so they can be unit-tested under node:test. The
 * DOM helpers only read the tree and are called from event handlers, never
 * during render, so server-side rendering stays safe.
 */

export const FOCUSABLE_SELECTOR = [
  "a[href]",
  "area[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "iframe",
  "[contenteditable='true']",
  "[tabindex]:not([tabindex='-1'])",
].join(", ");

export type RovingAxis = "horizontal" | "vertical";

/**
 * Index that a navigation key moves to inside a roving group (tabs, menu items).
 * Arrow keys wrap at both ends; Home and End jump to the first and last item.
 * Returns null when the key does not move the selection or the group is empty.
 * A current index of -1 means "nothing selected yet".
 */
export function nextRovingIndex(key: string, current: number, count: number, axis: RovingAxis): number | null {
  if (count <= 0) return null;
  const hasCurrent = current >= 0 && current < count;
  const forward = axis === "horizontal" ? "ArrowRight" : "ArrowDown";
  const backward = axis === "horizontal" ? "ArrowLeft" : "ArrowUp";
  switch (key) {
    case forward:
      return hasCurrent ? (current + 1) % count : 0;
    case backward:
      return hasCurrent ? (current - 1 + count) % count : count - 1;
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return null;
  }
}

/**
 * Index to focus next when Tab (or Shift+Tab) would leave a modal. The focus
 * trap always stays inside the list, including when focus is outside it.
 */
export function trapFocusIndex(current: number, count: number, backwards: boolean): number {
  if (count <= 0) return -1;
  if (current < 0 || current >= count) return backwards ? count - 1 : 0;
  if (backwards) return current === 0 ? count - 1 : current - 1;
  return current === count - 1 ? 0 : current + 1;
}

export function isDismissKey(key: string): boolean {
  return key === "Escape" || key === "Esc";
}

/** Focusable descendants that are visible to the user (not inside a hidden subtree). */
export function focusableWithin(root: ParentNode): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter((element) =>
    element.closest("[hidden]") === null && element.getAttribute("aria-hidden") !== "true",
  );
}
