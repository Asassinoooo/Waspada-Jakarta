import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { isDismissKey, nextRovingIndex } from "./a11y.js";

export interface MenuItem {
  id: string;
  label: string;
  /** Renders a link (menuitem) when set; otherwise a button that calls onSelect. */
  href?: string;
  onSelect?: () => void;
}

export interface MenuProps {
  triggerContent: ReactNode;
  triggerClassName?: string;
  items: readonly MenuItem[];
  align?: "start" | "end";
  defaultOpen?: boolean;
}

/**
 * Button-triggered menu. Opening focuses the first item; arrow keys, Home and End
 * move between items; Escape and outside pointer presses close it; Escape and
 * item selection return focus to the trigger.
 */
export function Menu({ triggerContent, triggerClassName, items, align = "start", defaultOpen = false }: MenuProps) {
  const [open, setOpen] = useState(defaultOpen);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const baseId = useId();
  const triggerId = `${baseId}-trigger`;
  const listId = `${baseId}-list`;

  useEffect(() => {
    if (!open) return;
    itemElements(listRef.current)[0]?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  function closeMenu(restoreFocus: boolean) {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  }

  function onListKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (isDismissKey(event.key)) {
      event.preventDefault();
      closeMenu(true);
      return;
    }
    if (event.key === "Tab") {
      closeMenu(false);
      return;
    }
    const elements = itemElements(listRef.current);
    const current = elements.indexOf(document.activeElement as HTMLElement);
    const next = nextRovingIndex(event.key, current, elements.length, "vertical");
    if (next === null) return;
    event.preventDefault();
    elements[next]?.focus();
  }

  return (
    <div className="menu" ref={rootRef}>
      <button
        ref={triggerRef}
        id={triggerId}
        type="button"
        className={triggerClassName ? `menu__trigger ${triggerClassName}` : "menu__trigger"}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" && !open) {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        {triggerContent}
      </button>
      {open && (
        <div
          ref={listRef}
          id={listId}
          role="menu"
          aria-labelledby={triggerId}
          className={`menu__list menu__list--${align}`}
          onKeyDown={onListKeyDown}
        >
          {items.map((item) => item.href !== undefined ? (
            <a
              key={item.id}
              role="menuitem"
              href={item.href}
              tabIndex={-1}
              className="menu__item"
              onClick={() => setOpen(false)}
            >
              {item.label}
            </a>
          ) : (
            <button
              key={item.id}
              type="button"
              role="menuitem"
              tabIndex={-1}
              className="menu__item"
              onClick={() => {
                closeMenu(true);
                item.onSelect?.();
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function itemElements(list: HTMLElement | null): HTMLElement[] {
  return Array.from(list?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);
}
