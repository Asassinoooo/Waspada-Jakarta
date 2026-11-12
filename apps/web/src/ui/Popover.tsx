import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { isDismissKey } from "./a11y.js";

export interface PopoverProps {
  triggerContent: ReactNode;
  triggerClassName?: string;
  panelClassName?: string;
  /** Panel content stays in the markup and is hidden until the trigger opens it. */
  children: ReactNode;
  defaultOpen?: boolean;
}

/**
 * Small anchored panel opened by a button (disclosure pattern). Escape and an
 * outside pointer press close it; Escape returns focus to the trigger.
 */
export function Popover({ triggerContent, triggerClassName, panelClassName, children, defaultOpen = false }: PopoverProps) {
  const [open, setOpen] = useState(defaultOpen);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelId = `${useId()}-panel`;

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (!isDismissKey(event.key) || !open) return;
    event.preventDefault();
    setOpen(false);
    triggerRef.current?.focus();
  }

  return (
    <div className="popover" ref={rootRef} onKeyDown={onKeyDown}>
      <button
        ref={triggerRef}
        type="button"
        className={triggerClassName ? `popover__trigger ${triggerClassName}` : "popover__trigger"}
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((current) => !current)}
      >
        {triggerContent}
      </button>
      <div id={panelId} className={panelClassName ? `popover__panel ${panelClassName}` : "popover__panel"} hidden={!open}>
        {children}
      </div>
    </div>
  );
}
