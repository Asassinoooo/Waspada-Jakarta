import * as React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  coordinateToWorldPixels,
  getVisibleMapTiles,
  worldPixelsToCoordinate,
  type MapCoordinate,
  type VisibleMapTile,
} from "./SourcePointMap.js";
import {
  facilityKindIcon,
  facilityKindLabel,
  findNearbyFacilities,
  type EmergencyFacilityKind,
  type NearbyFacility,
} from "./emergency-facilities.js";

// Browser-only, like the other page stylesheets: keeps the component importable under Node SSR tests.
if (typeof document !== "undefined") {
  void import("./incident-map.css");
}

export interface InteractiveIncidentMapProps {
  /** Incident coordinates [longitude, latitude] */
  readonly coordinates: readonly [longitude: number, latitude: number] | null;
  /** Incident category type (e.g., "flood", "fire", etc.) */
  readonly incidentType: string;
  /** Incident severity level */
  readonly severity: "low" | "medium" | "high" | "critical" | "unknown";
  /** Descriptive location label */
  readonly locationLabel?: string | null;
  /** Proposal title */
  readonly title: string;
  /** Optional external selected facility ID */
  readonly selectedFacilityId?: string | null;
  /** Callback when user clicks a facility pin */
  readonly onSelectFacility?: (facility: NearbyFacility | null) => void;
  /** Active citation quote to highlight / focus */
  readonly activeQuote?: string | null;
  /** Optional custom tile URL template */
  readonly tileTemplate?: string;
  /** Map container height in pixels */
  readonly height?: number;
}

const DEFAULT_JAKARTA_CENTER: MapCoordinate = [106.8456, -6.2088];
const DEFAULT_ZOOM = 14;

export function mapIncidentTypeLabel(type: string): string {
  switch (type) {
    case "flood": return "Banjir";
    case "fire": return "Kebakaran";
    case "accident": return "Kecelakaan";
    case "tree_fall": return "Pohon Tumbang";
    case "crime": return "Kriminalitas";
    case "weather": return "Cuaca Ekstrem";
    default: {
      const formatted = type.replace(/_/g, " ");
      return formatted.charAt(0).toUpperCase() + formatted.slice(1);
    }
  }
}

export function mapSeverityLabel(sev: string): string {
  switch (sev) {
    case "critical": return "Kritis";
    case "high": return "Tinggi";
    case "medium": return "Sedang";
    case "low": return "Rendah";
    case "unknown": return "Belum Ditentukan";
    default: return sev;
  }
}

export function incidentTypeIcon(type: string): string {
  const lower = type.toLowerCase();
  if (lower.includes("flood") || lower.includes("banjir") || lower.includes("genang") || lower.includes("air")) return "🌊";
  if (lower.includes("fire") || lower.includes("kebakaran") || lower.includes("api")) return "🔥";
  if (lower.includes("accident") || lower.includes("kecelakaan") || lower.includes("tabrakan") || lower.includes("truk")) return "🚗";
  if (lower.includes("tree") || lower.includes("pohon") || lower.includes("tumbang")) return "🌳";
  if (lower.includes("crime") || lower.includes("kriminal") || lower.includes("begal") || lower.includes("tawuran")) return "🚨";
  if (lower.includes("weather") || lower.includes("cuaca") || lower.includes("angin") || lower.includes("badai")) return "⛈️";
  if (lower.includes("listrik") || lower.includes("pole") || lower.includes("tiang")) return "⚡";
  if (lower.includes("pipa") || lower.includes("pdam")) return "🚰";
  return "⚠️";
}

// MERGE-REVIEW-01: no severity-based danger radius. No source supplies one, so the map draws none.

export function InteractiveIncidentMap({
  coordinates,
  incidentType,
  severity,
  locationLabel,
  title,
  selectedFacilityId: externalSelectedFacilityId,
  onSelectFacility,
  tileTemplate = "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
  height = 420,
}: InteractiveIncidentMapProps) {
  const effectiveCenter: MapCoordinate = useMemo(() => {
    return coordinates ?? DEFAULT_JAKARTA_CENTER;
  }, [coordinates]);

  const [center, setCenter] = useState<MapCoordinate>(effectiveCenter);
  const [zoom, setZoom] = useState<number>(DEFAULT_ZOOM);
  const [activeFacilityFilter, setActiveFacilityFilter] = useState<"all" | EmergencyFacilityKind>("all");
  const [selectedFacility, setSelectedFacility] = useState<NearbyFacility | null>(null);
  const [isDragging, setIsDragging] = useState<boolean>(false);
  const dragRef = useRef<{ startX: number; startY: number; centerPx: { x: number; y: number } } | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setCenter(effectiveCenter);
    setZoom(DEFAULT_ZOOM);
  }, [effectiveCenter]);

  const nearbyFacilities = useMemo(() => {
    return findNearbyFacilities(effectiveCenter, 5000, 30);
  }, [effectiveCenter]);

  const facilityCounts = useMemo(() => {
    const counts = { hospital: 0, police: 0, fire_station: 0 };
    for (const f of nearbyFacilities) {
      counts[f.kind] = (counts[f.kind] || 0) + 1;
    }
    return counts;
  }, [nearbyFacilities]);

  const filteredFacilities = useMemo(() => {
    if (activeFacilityFilter === "all") return nearbyFacilities;
    return nearbyFacilities.filter((f) => f.kind === activeFacilityFilter);
  }, [nearbyFacilities, activeFacilityFilter]);

  const [viewportSize, setViewportSize] = useState<{ width: number; height: number }>({
    width: 1200,
    height: height,
  });

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const updateSize = () => {
      const rect = el.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        setViewportSize((cur) =>
          cur.width === rect.width && cur.height === rect.height
            ? cur
            : { width: Math.round(rect.width), height: Math.round(rect.height) }
        );
      }
    };
    updateSize();
    if (typeof ResizeObserver !== "undefined") {
      const observer = new ResizeObserver(updateSize);
      observer.observe(el);
      return () => observer.disconnect();
    }
    window.addEventListener("resize", updateSize);
    return () => window.removeEventListener("resize", updateSize);
  }, []);

  const width = viewportSize.width;
  const mapHeight = viewportSize.height;

  // Safezone buffer: generate tiles with +512px width buffer and +256px height buffer
  const SAFE_BUFFER_X = 512;
  const SAFE_BUFFER_Y = 256;
  const bufferWidth = width + SAFE_BUFFER_X;
  const bufferHeight = mapHeight + SAFE_BUFFER_Y;

  const centerWorldPx = useMemo(() => {
    return coordinateToWorldPixels(center, zoom);
  }, [center, zoom]);

  const projectPoint = useCallback(
    (coord: MapCoordinate) => {
      const worldPx = coordinateToWorldPixels(coord, zoom);
      return {
        x: width / 2 + (worldPx.x - centerWorldPx.x),
        y: mapHeight / 2 + (worldPx.y - centerWorldPx.y),
      };
    },
    [centerWorldPx, zoom, width, mapHeight]
  );

  const incidentCanvasPx = useMemo(() => {
    if (!coordinates) return null;
    return projectPoint(coordinates);
  }, [coordinates, projectPoint]);

  const tiles: VisibleMapTile[] = useMemo(() => {
    return getVisibleMapTiles(bufferWidth, bufferHeight, center, zoom);
  }, [bufferWidth, bufferHeight, center, zoom]);
  const handleZoomIn = () => {
    setZoom((z) => Math.min(18, z + 1));
  };

  const handleZoomOut = () => {
    setZoom((z) => Math.max(10, z - 1));
  };

  const handleRecenter = () => {
    setCenter(effectiveCenter);
    setZoom(DEFAULT_ZOOM);
    setSelectedFacility(null);
    onSelectFacility?.(null);
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    setIsDragging(true);
    dragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      centerPx: { ...centerWorldPx },
    };
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!isDragging || !dragRef.current) return;
    const dx = e.clientX - dragRef.current.startX;
    const dy = e.clientY - dragRef.current.startY;
    const nextWorldX = dragRef.current.centerPx.x - dx;
    const nextWorldY = dragRef.current.centerPx.y - dy;
    const newCoord = worldPixelsToCoordinate(nextWorldX, nextWorldY, zoom);
    setCenter(newCoord);
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (isDragging) {
      setIsDragging(false);
      dragRef.current = null;
      (e.target as HTMLElement).releasePointerCapture?.(e.pointerId);
    }
  };

  const handleFacilityClick = (facility: NearbyFacility) => {
    setSelectedFacility(facility);
    onSelectFacility?.(facility);
  };

  const activeSelectedId = externalSelectedFacilityId ?? selectedFacility?.id ?? null;

  return (
    <div className="incident-map-wrapper">
      <div
        className={`interactive-incident-map${isDragging ? " interactive-incident-map--dragging" : ""}`}
        data-testid="interactive-incident-map"
        ref={containerRef}
        style={{ height: `${mapHeight}px` }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        role="region"
        aria-label={`Peta interaktif insiden ${title} di ${locationLabel}`}
      >
        {/* Basemap Tiles with Safezone Offset */}
        <div
          className="map-tile-layer"
          style={{
            left: `-${SAFE_BUFFER_X / 2}px`,
            top: `-${SAFE_BUFFER_Y / 2}px`,
            width: `${bufferWidth}px`,
            height: `${bufferHeight}px`,
          }}
        >
          {tiles.map((tile) => {
            const tileUrl = tileTemplate
              .replace("{z}", String(tile.zoom))
              .replace("{x}", String(tile.x))
              .replace("{y}", String(tile.y));
            return (
              <img
                key={tile.key}
                src={tileUrl}
                alt=""
                loading="lazy"
                className="map-tile-img"
                style={{
                  left: `${tile.left}px`,
                  top: `${tile.top}px`,
                }}
              />
            );
          })}
        </div>

        {/* SVG Overlay */}
        <svg
          className="map-svg-layer"
          viewBox={`0 0 ${width} ${mapHeight}`}
        >
          {/* MERGE-REVIEW-01: no affected-radius circle. A radius is not in any source, so none is drawn. */}

          {/* Clean Facility Pins (Icons without overlapping text clutter) */}
          <g className="map-facilities-group">
            {filteredFacilities.map((facility) => {
              const pos = projectPoint(facility.coordinates);
              if (pos.x < -30 || pos.x > width + 30 || pos.y < -30 || pos.y > mapHeight + 30) {
                return null;
              }
              const isSelected = activeSelectedId === facility.id;

              return (
                <g
                  key={facility.id}
                  className={`facility-pin facility-pin--${facility.kind} ${
                    isSelected ? "facility-pin--selected" : ""
                  }`}
                  transform={`translate(${pos.x}, ${pos.y})`}
                  onClick={(e) => {
                    e.stopPropagation();
                    handleFacilityClick(facility);
                  }}
                >
                  <circle
                    cx="0"
                    cy="0"
                    r={isSelected ? 14 : 9}
                    strokeWidth={isSelected ? 3 : 1.5}
                    className="facility-pin-circle"
                  />
                  <text
                    cx="0"
                    cy="3"
                    textAnchor="middle"
                    fontSize={isSelected ? 11 : 8}
                    className="facility-pin-emoji"
                  >
                    {facilityKindIcon(facility.kind)}
                  </text>
                  <title>{`${facilityKindLabel(facility.kind)}: ${facility.title} (${facility.distanceMeters} m)`}</title>
                </g>
              );
            })}
          </g>

          {/* Incident Pin Marker */}
          {incidentCanvasPx && (
            <g
              className="incident-pin-marker"
              transform={`translate(${incidentCanvasPx.x}, ${incidentCanvasPx.y})`}
              onClick={(e) => {
                e.stopPropagation();
                handleRecenter();
              }}
            >
              <circle
                cx="0"
                cy="0"
                r="18"
                className="incident-beacon-pulse"
                strokeWidth="2"
                opacity="0.6"
              />
              <circle
                cx="0"
                cy="0"
                r="14"
                className="incident-beacon-inner"
                strokeWidth="1.5"
                opacity="0.8"
              />
              <circle
                cx="0"
                cy="0"
                r="11"
                className="incident-beacon-core"
                strokeWidth="2"
              />
              <text
                cx="0"
                cy="4"
                textAnchor="middle"
                fontSize="9"
                className="incident-pin-icon"
              >
                {incidentTypeIcon(incidentType)}
              </text>
              <g transform="translate(0, -20)" className="incident-title-chip">
                <rect
                  x="-65"
                  y="-12"
                  width="130"
                  height="20"
                  rx="4"
                  strokeWidth="1"
                />
                <text
                  x="0"
                  y="2"
                  textAnchor="middle"
                  fontSize="10"
                  fontWeight="600"
                >
                  {mapIncidentTypeLabel(incidentType)} · {mapSeverityLabel(severity)}
                </text>
              </g>
            </g>
          )}
        </svg>

        {/* Floating Facility Filter Controls (Top-Left) */}
        <div
          className="map-facility-filters"
          role="toolbar"
          aria-label="Filter fasilitas darurat"
          onPointerDown={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            className={`filter-pill facility-filter-pill ${activeFacilityFilter === "all" ? "facility-filter-pill--active" : ""}`}
            onClick={() => setActiveFacilityFilter("all")}
            aria-pressed={activeFacilityFilter === "all"}
            title="Semua Fasilitas"
            aria-label="Filter semua fasilitas"
          >
            Semua Fasilitas ({nearbyFacilities.length})
          </button>
          <button
            type="button"
            className={`filter-pill facility-filter-pill ${activeFacilityFilter === "hospital" ? "facility-filter-pill--active" : ""}`}
            onClick={() => setActiveFacilityFilter("hospital")}
            aria-pressed={activeFacilityFilter === "hospital"}
            title="Rumah Sakit"
            aria-label="Filter rumah sakit"
          >
            🏥 RS ({facilityCounts.hospital})
          </button>
          <button
            type="button"
            className={`filter-pill facility-filter-pill ${activeFacilityFilter === "police" ? "facility-filter-pill--active" : ""}`}
            onClick={() => setActiveFacilityFilter("police")}
            aria-pressed={activeFacilityFilter === "police"}
            title="Kepolisian"
            aria-label="Filter kepolisian"
          >
            👮 Polisi ({facilityCounts.police})
          </button>
          <button
            type="button"
            className={`filter-pill facility-filter-pill ${activeFacilityFilter === "fire_station" ? "facility-filter-pill--active" : ""}`}
            onClick={() => setActiveFacilityFilter("fire_station")}
            aria-pressed={activeFacilityFilter === "fire_station"}
            title="Pemadam Kebakaran"
            aria-label="Filter pemadam kebakaran"
          >
            🚒 Damkar ({facilityCounts.fire_station})
          </button>
        </div>

        {/* Zoom & Recenter Controls (Bottom-Right) */}
        <div
          className="map-zoom-controls"
          role="group"
          aria-label="Kontrol navigasi peta"
          onPointerDown={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            className="map-tool-btn"
            onClick={handleZoomIn}
            title="Perbesar"
            aria-label="Perbesar peta"
          >
            +
          </button>
          <button
            type="button"
            className="map-tool-btn"
            onClick={handleZoomOut}
            title="Perkecil"
            aria-label="Perkecil peta"
          >
            −
          </button>
          <button
            type="button"
            className="map-tool-btn map-tool-btn--recenter"
            onClick={handleRecenter}
            title="Pusatkan kembali ke titik insiden"
            aria-label="Pusatkan kembali ke titik insiden"
          >
            Pusatkan
          </button>
        </div>
      </div>

      {/* Clean Collapsible Nearby Facilities Details List (Underneath the map) */}
      <details className="nearby-facilities-details">
        <summary className="nearby-facilities-summary">
          Fasilitas Darurat Terdekat ({filteredFacilities.length} lokasi terdata)
        </summary>
        <div className="nearby-facilities-grid">
          {filteredFacilities.slice(0, 8).map((f) => (
            <div
              key={f.id}
              onClick={() => handleFacilityClick(f)}
              className="nearby-facility-card"
            >
              <div className="nearby-facility-title">
                {facilityKindIcon(f.kind)} {f.title}
              </div>
              <div className="nearby-facility-meta">
                {facilityKindLabel(f.kind)} · {f.distanceMeters} m
              </div>
            </div>
          ))}
        </div>
      </details>
    </div>
  );
}
