import { SEVERITY_LEVELS, SEVERITY_NOTE, severityLabel, type PublicSeverity } from "./published-events.js";

/**
 * SEV-01 chip: "Tingkat dampak: Tinggi". The note is the tooltip. The detail sheet also prints it as text.
 * One text node, so the chip reads the same in server markup and in the browser.
 */
export function SeverityChip({ level }: { level: PublicSeverity }) {
  return (
    <span className={`map-severity-chip map-severity-chip--${level}`} title={SEVERITY_NOTE}>
      {`Tingkat dampak: ${severityLabel(level)}`}
    </span>
  );
}

/** Key for the marker sizes. It sits in the bottom-right corner, above the zoom controls. */
export function MapLegend() {
  return (
    <aside className="map-legend" aria-label="Keterangan ukuran ikon" title="Ukuran ikon = tingkat dampak">
      <p className="map-legend__title">Ukuran ikon = tingkat dampak</p>
      <ul className="map-legend__items">
        {SEVERITY_LEVELS.map((level) => (
          <li key={level} className="map-legend__item">
            <span className={`map-legend__dot map-legend__dot--${level}`} aria-hidden="true" />
            <span>{severityLabel(level)}</span>
          </li>
        ))}
      </ul>
    </aside>
  );
}
