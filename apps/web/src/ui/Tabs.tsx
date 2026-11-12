import { useRef, type KeyboardEvent, type ReactNode } from "react";
import { nextRovingIndex, type RovingAxis } from "./a11y.js";

export interface TabItem {
  id: string;
  label: string;
  /** Decorative icon shown before the label. It must not carry meaning on its own. */
  icon?: ReactNode;
}

export interface TabsProps {
  /** Prefix for element ids; keeps tab and panel ids unique on the page. */
  idPrefix: string;
  /** Accessible name of the tablist. */
  label: string;
  tabs: readonly TabItem[];
  value: string;
  onChange: (id: string) => void;
  /** Horizontal strip (ArrowLeft and ArrowRight) or vertical rail (ArrowUp and ArrowDown). Defaults to horizontal. */
  orientation?: RovingAxis;
}

/**
 * Tab strip with roving tabindex. Arrow keys for the chosen orientation wrap at both ends;
 * Home and End jump to the ends.
 */
export function Tabs({ idPrefix, label, tabs, value, onChange, orientation = "horizontal" }: TabsProps) {
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const selectedIndex = tabs.findIndex((tab) => tab.id === value);

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const next = nextRovingIndex(event.key, selectedIndex, tabs.length, orientation);
    if (next === null) return;
    event.preventDefault();
    const tab = tabs[next];
    if (!tab) return;
    onChange(tab.id);
    buttons.current[next]?.focus();
  }

  return (
    <div role="tablist" aria-label={label} aria-orientation={orientation} className="tabs" onKeyDown={onKeyDown}>
      {tabs.map((tab, index) => {
        const selected = tab.id === value;
        return (
          <button
            key={tab.id}
            ref={(element) => {
              buttons.current[index] = element;
            }}
            id={`${idPrefix}-tab-${tab.id}`}
            type="button"
            role="tab"
            className="tabs__tab"
            aria-selected={selected}
            aria-controls={`${idPrefix}-panel-${tab.id}`}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(tab.id)}
          >
            {tab.icon !== undefined && <span className="tabs__icon" aria-hidden="true">{tab.icon}</span>}
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}

export interface TabPanelProps {
  idPrefix: string;
  id: string;
  active: boolean;
  children: ReactNode;
}

export function TabPanel({ idPrefix, id, active, children }: TabPanelProps) {
  return (
    <div
      id={`${idPrefix}-panel-${id}`}
      role="tabpanel"
      aria-labelledby={`${idPrefix}-tab-${id}`}
      tabIndex={0}
      hidden={!active}
      className="tabs__panel"
    >
      {children}
    </div>
  );
}
