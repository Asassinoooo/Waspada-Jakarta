import { useRef, type ReactNode } from "react";
import { useModalFocus } from "./Dialog.js";

export interface SheetProps {
  open: boolean;
  onClose: () => void;
  titleId: string;
  /** Edge used for the side panel at 900px and wider. Below 900px the sheet always rises from the bottom. */
  side?: "left" | "right";
  className?: string;
  children: ReactNode;
}

export function Sheet({ open, onClose, titleId, side = "right", className, children }: SheetProps) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  useModalFocus(open, surfaceRef, onClose);
  if (!open) return null;
  return (
    <div
      className={`sheet-overlay sheet-overlay--${side}`}
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
        className={className ? `sheet ${className}` : "sheet"}
      >
        {children}
      </div>
    </div>
  );
}
