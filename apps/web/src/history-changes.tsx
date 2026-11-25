import type { FreshnessStatus, HistoryChange, Lifecycle } from "@waspada/worker/public-contracts";
import { categoryLabel, eventTimeText, formatInstant, freshnessLabel, lifecycleLabel } from "./display.js";

/** HIST-UI-01: plain-language rows for what changed from the previous published version. */

export type HistoryChangeRow =
  | { kind: "value"; field: string; label: string; before: string; after: string }
  | { kind: "names"; field: string; label: string; added: string[]; removed: string[] }
  | { kind: "count"; field: string; label: string; before: number; after: number };

const FIELD_LABELS: Record<HistoryChange["field"], string> = {
  title: "Judul",
  summary: "Ringkasan",
  category: "Kategori",
  lifecycle: "Status kejadian",
  freshness: "Status tinjau",
  event_time: "Waktu kejadian",
  validity: "Masa berlaku",
  places: "Lokasi",
  services: "Layanan",
  institutions: "Lembaga",
  audiences: "Kelompok terdampak",
  claims: "Klaim",
  impacts: "Dampak",
};

const EMPTY_VALUE = "Tidak ada";

const LIFECYCLES = new Set<string>(["planned", "ongoing", "resolved", "cancelled", "unknown"]);
const FRESHNESS = new Set<string>(["current", "needs_update", "expired"]);
const PRECISIONS = new Set<string>(["exact", "date", "range"]);

function dashToNull(value: string | undefined): string | null {
  return value === undefined || value === "-" ? null : value;
}

/** The worker encodes event_time as "<precision> <start|-> <end|->"; null means unknown. */
function eventTimeValue(value: string | null): string {
  if (value === null) return eventTimeText({ precision: "unknown", start: null, end: null });
  const [precision, start, end] = value.split(" ");
  if (precision === undefined || !PRECISIONS.has(precision)) return value;
  return eventTimeText({
    precision: precision as "exact" | "date" | "range",
    start: dashToNull(start),
    end: dashToNull(end),
  });
}

/** The worker encodes validity as "<from|-> <until|->"; null means no validity window. */
function validityValue(value: string | null): string {
  if (value === null) return "Tidak ada masa berlaku dari sumber";
  const [from, until] = value.split(" ").map(dashToNull);
  if (from && until) return `${formatInstant(from)} – ${formatInstant(until)}`;
  if (until) return `Sampai ${formatInstant(until)}`;
  if (from) return `Mulai ${formatInstant(from)}`;
  return EMPTY_VALUE;
}

function textValue(field: string, value: string | null): string {
  switch (field) {
    case "category":
      return value === null ? EMPTY_VALUE : categoryLabel(value);
    case "lifecycle":
      return value !== null && LIFECYCLES.has(value) ? lifecycleLabel(value as Lifecycle, { fixtureWording: false }) : (value ?? EMPTY_VALUE);
    case "freshness":
      return value !== null && FRESHNESS.has(value) ? freshnessLabel(value as FreshnessStatus, { fixtureWording: false }) : (value ?? EMPTY_VALUE);
    case "event_time":
      return eventTimeValue(value);
    case "validity":
      return validityValue(value);
    default:
      return value === null || value.trim() === "" ? EMPTY_VALUE : value;
  }
}

export function historyChangeRows(changes: readonly HistoryChange[]): HistoryChangeRow[] {
  return changes.map((change): HistoryChangeRow => {
    const label = FIELD_LABELS[change.field] ?? change.field;
    if ("added" in change) {
      return { kind: "names", field: change.field, label, added: [...change.added], removed: [...change.removed] };
    }
    if ("before_count" in change) {
      return { kind: "count", field: change.field, label, before: change.before_count, after: change.after_count };
    }
    return {
      kind: "value",
      field: change.field,
      label,
      before: textValue(change.field, change.before),
      after: textValue(change.field, change.after),
    };
  });
}

function countText(field: string, value: number): string {
  return `${value} ${field === "claims" ? "klaim" : "dampak"}`;
}

export function HistoryChanges({ changes }: { changes: readonly HistoryChange[] | undefined }) {
  if (!changes || changes.length === 0) return null;
  const rows = historyChangeRows(changes);
  return (
    <details className="history-changes">
      <summary>
        Lihat perubahan <span className="history-changes__count">({rows.length})</span>
      </summary>
      <p className="history-changes__note">Dibandingkan dengan versi terbit sebelumnya.</p>
      <dl className="history-changes__list">
        {rows.map((row) => (
          <div className="history-changes__row" key={row.field}>
            <dt>{row.label}</dt>
            <dd>
              {row.kind === "value" && (
                <span className="history-changes__diff">
                  <del><span className="visually-hidden">Sebelum: </span>{row.before}</del>
                  <span className="history-changes__arrow" aria-hidden="true">→</span>
                  <ins><span className="visually-hidden">Sesudah: </span>{row.after}</ins>
                </span>
              )}
              {row.kind === "count" && (
                <span className="history-changes__diff">
                  <del><span className="visually-hidden">Sebelum: </span>{countText(row.field, row.before)}</del>
                  <span className="history-changes__arrow" aria-hidden="true">→</span>
                  <ins><span className="visually-hidden">Sesudah: </span>{countText(row.field, row.after)}</ins>
                </span>
              )}
              {row.kind === "names" && (
                <ul className="history-changes__chips">
                  {row.added.map((name) => (
                    <li className="history-chip history-chip--added" key={`+${name}`}>
                      <span aria-hidden="true">+</span><span className="visually-hidden">Ditambahkan: </span>{name}
                    </li>
                  ))}
                  {row.removed.map((name) => (
                    <li className="history-chip history-chip--removed" key={`-${name}`}>
                      <span aria-hidden="true">−</span><span className="visually-hidden">Dihapus: </span>{name}
                    </li>
                  ))}
                </ul>
              )}
            </dd>
          </div>
        ))}
      </dl>
    </details>
  );
}
