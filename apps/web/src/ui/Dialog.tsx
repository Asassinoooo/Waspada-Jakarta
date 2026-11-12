import { useEffect, useRef, type ReactNode, type RefObject } from "react";
import { focusableWithin, isDismissKey, trapFocusIndex } from "./a11y.js";

/**
 * Shared modal behaviour: focus moves into the surface on open, Tab cycles
 * inside it, Escape calls onClose, and focus returns to the opener on close.
 * Effects only run in the browser, so server rendering stays safe.
 */
export function useModalFocus(
  open: boolean,
  surfaceRef: RefObject<HTMLElement | null>,
  onClose: () => void,
): void {
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const surface = surfaceRef.current;
    if (surface) {
      const [first] = focusableWithin(surface);
      (first ?? surface).focus({ preventScroll: true });
    }

    function onKeyDown(event: KeyboardEvent) {
      if (isDismissKey(event.key)) {
        event.preventDefault();
        closeRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const root = surfaceRef.current;
      if (!root) return;
      const items = focusableWithin(root);
      event.preventDefault();
      if (items.length === 0) {
        root.focus({ preventScroll: true });
        return;
      }
      const index = items.indexOf(document.activeElement as HTMLElement);
      items[trapFocusIndex(index, items.length, event.shiftKey)]?.focus({ preventScroll: true });
    }

    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, [open, surfaceRef]);
}

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  /** id of the element that names the dialog (usually its heading). */
  titleId: string;
  className?: string;
  children: ReactNode;
}

export function Dialog({ open, onClose, titleId, className, children }: DialogProps) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  useModalFocus(open, surfaceRef, onClose);
  if (!open) return null;
  return (
    <div
      className="modal-overlay ui-overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={surfaceRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={className ? `modal-dialog ui-dialog ${className}` : "modal-dialog ui-dialog"}
      >
        {children}
      </div>
    </div>
  );
}
