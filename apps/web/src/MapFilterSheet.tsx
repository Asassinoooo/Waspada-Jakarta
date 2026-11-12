import { useState } from "react";
import { facilityKindIcon, type EmergencyFacilityKind } from "./emergency-facilities.js";
import { Sheet } from "./ui/Sheet.js";
import {
  DEFAULT_PUBLISHED_FILTERS,
  FILTER_CATEGORIES,
  SOURCE_OPTIONS,
  TIME_RANGE_OPTIONS,
  categoryText,
  type EventTimeRange,
  type EvidenceKind,
  type PublishedFilters,
} from "./published-events.js";

export interface MapFilterValue {
  filters: PublishedFilters;
  facilitiesOn: boolean;
  facilityKinds: readonly EmergencyFacilityKind[];
}

export const DEFAULT_MAP_FILTER_VALUE: MapFilterValue = {
  filters: DEFAULT_PUBLISHED_FILTERS,
  facilitiesOn: false,
  facilityKinds: ["hospital", "police", "fire_station"],
};

export const FACILITY_NOTE = "Lokasi fasilitas dari OSM; tidak menunjukkan kesiapan layanan.";
export const TIME_NOTE = "Laporan tanpa waktu kejadian yang diketahui hanya tampil pada Semua waktu.";

const FACILITY_OPTIONS: readonly { kind: EmergencyFacilityKind; label: string }[] = [
  { kind: "hospital", label: "RS" },
  { kind: "police", label: "Polisi" },
  { kind: "fire_station", label: "Damkar" },
];

export interface MapFilterSheetProps {
  applied: MapFilterValue;
  onApply: (value: MapFilterValue) => void;
  onClose: () => void;
}

/** Filter sheet. Changes stay in a draft until "Terapkan". "Reset" clears the draft only. */
export function MapFilterSheet({ applied, onApply, onClose }: MapFilterSheetProps) {
  const [draft, setDraft] = useState<MapFilterValue>(applied);

  const setFilter = <K extends keyof PublishedFilters>(key: K, value: PublishedFilters[K]) =>
    setDraft((current) => ({ ...current, filters: { ...current.filters, [key]: value } }));

  const toggleKind = (kind: EmergencyFacilityKind) =>
    setDraft((current) => ({
      ...current,
      facilityKinds: current.facilityKinds.includes(kind)
        ? current.facilityKinds.filter((item) => item !== kind)
        : [...current.facilityKinds, kind],
    }));

  return (
    <Sheet open onClose={onClose} titleId="map-filter-title" side="left" className="map-filter-sheet">
      <div className="map-filter__head">
        <h2 id="map-filter-title">Filter laporan</h2>
        <button type="button" className="button button--quiet button--sm" onClick={onClose}>
          Tutup
        </button>
      </div>

      <fieldset className="map-filter__group">
        <legend>Kategori</legend>
        <div className="map-filter__chips">
          <button
            type="button"
            className="filter-pill"
            aria-pressed={draft.filters.category === "all"}
            onClick={() => setFilter("category", "all")}
          >
            Semua kategori
          </button>
          {FILTER_CATEGORIES.map((category) => (
            <button
              key={category}
              type="button"
              className="filter-pill"
              aria-pressed={draft.filters.category === category}
              onClick={() => setFilter("category", category)}
            >
              {categoryText(category)}
            </button>
          ))}
        </div>
      </fieldset>

      <fieldset className="map-filter__group">
        <legend>Waktu kejadian</legend>
        <div className="map-filter__chips">
          {TIME_RANGE_OPTIONS.map((option: { value: EventTimeRange; label: string }) => (
            <button
              key={option.value}
              type="button"
              className="filter-pill"
              aria-pressed={draft.filters.timeRange === option.value}
              onClick={() => setFilter("timeRange", option.value)}
            >
              {option.label}
            </button>
          ))}
        </div>
        <p className="map-filter__note muted">{TIME_NOTE}</p>
      </fieldset>

      <fieldset className="map-filter__group">
        <legend>Jenis sumber</legend>
        <div className="map-filter__chips">
          <button
            type="button"
            className="filter-pill"
            aria-pressed={draft.filters.source === "all"}
            onClick={() => setFilter("source", "all")}
          >
            Semua sumber
          </button>
          {SOURCE_OPTIONS.map((option: { value: EvidenceKind; label: string }) => (
            <button
              key={option.value}
              type="button"
              className="filter-pill"
              aria-pressed={draft.filters.source === option.value}
              onClick={() => setFilter("source", option.value)}
            >
              {option.label}
            </button>
          ))}
        </div>
      </fieldset>

      <fieldset className="map-filter__group">
        <legend>Fasilitas darurat</legend>
        <label className="map-filter__switch">
          <input
            type="checkbox"
            checked={draft.facilitiesOn}
            onChange={(event) => setDraft((current) => ({ ...current, facilitiesOn: event.target.checked }))}
          />
          <span>Tampilkan fasilitas di peta</span>
        </label>
        <div className="map-filter__chips">
          {FACILITY_OPTIONS.map((option) => (
            <button
              key={option.kind}
              type="button"
              className="filter-pill"
              aria-pressed={draft.facilityKinds.includes(option.kind)}
              disabled={!draft.facilitiesOn}
              onClick={() => toggleKind(option.kind)}
            >
              <span aria-hidden="true">{facilityKindIcon(option.kind)}</span> {option.label}
            </button>
          ))}
        </div>
        <p className="map-filter__note muted">{FACILITY_NOTE}</p>
      </fieldset>

      <div className="map-filter__actions">
        <button type="button" className="button button--quiet" onClick={() => setDraft(DEFAULT_MAP_FILTER_VALUE)}>
          Reset
        </button>
        <button type="button" className="button button--primary" onClick={() => onApply(draft)}>
          Terapkan
        </button>
      </div>
    </Sheet>
  );
}
