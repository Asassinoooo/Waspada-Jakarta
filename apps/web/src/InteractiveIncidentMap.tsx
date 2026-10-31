import * as React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  clampMapZoom,
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

export function calculateAffectedRadiusMeters(severity: string, incidentType: string): number {
  switch (severity) {
    case "critical":
      return incidentType === "flood" ? 1500 : 1200;
    case "high":
      return incidentType === "flood" ? 1000 : 800;
    case "medium":
      return incidentType === "flood" ? 600 : 500;
    case "low":
    default:
      return incidentType === "flood" ? 300 : 250;
  }
}

export function metersToPixels(meters: number, latitude: number, zoom: number): number {
  const earthCircumference = 40075016;
  const latRad = (latitude * Math.PI) / 180;
  const metersPerPixel = (earthCircumference * Math.cos(latRad)) / (256 * 2 ** clampMapZoom(zoom));
  return Math.max(16, Math.round(meters / metersPerPixel));
}

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

  const radiusMeters = useMemo(
    () => calculateAffectedRadiusMeters(severity, incidentType),
    [severity, incidentType]
  );

  const radiusPixels = useMemo(() => {
    const lat = center[1];
    return metersToPixels(radiusMeters, lat, zoom);
  }, [radiusMeters, center, zoom]);

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
      <style>{`
        .interactive-incident-map {
          position: relative;
          width: 100%;
          border-radius: 8px;
          overflow: hidden;
          background-color: var(--surface);
          border: 1px solid var(--beton);
          user-select: none;
        }
        .map-tile-layer {
          position: absolute;
          pointer-events: none;
        }
        .map-tile-img {
          position: absolute;
          width: 256px;
          height: 256px;
          display: block;
        }
        .map-svg-layer {
          position: absolute;
          top: 0;
          left: 0;
          width: 100%;
          height: 100%;
          pointer-events: none;
        }
        .map-facilities-group {
          pointer-events: auto;
        }
        .facility-pin {
          cursor: pointer;
        }
        .incident-pin-marker {
          pointer-events: auto;
          cursor: pointer;
        }
        .incident-beacon-pulse {
          animation: incident-beacon-pulse-anim 2s cubic-bezier(0, 0.2, 0.8, 1) infinite;
          stroke: var(--merah-tanda);
        }
        @keyframes incident-beacon-pulse-anim {
          0% {
            r: 14px;
            opacity: 0.8;
          }
          70% {
            r: 22px;
            opacity: 0;
          }
          100% {
            r: 22px;
            opacity: 0;
          }
        }
        .incident-beacon-inner {
          stroke: var(--merah-tanda);
          opacity: 0.8;
        }
        .incident-beacon-core {
          fill: var(--merah-tanda);
          opacity: 1;
        }
        .map-facility-filters {
          position: absolute;
          top: 0.5rem;
          left: 0.5rem;
          z-index: 5;
          display: flex;
          flex-wrap: wrap;
          gap: 0.25rem;
          background: var(--surface);
          border: 1px solid var(--beton);
          border-radius: 6px;
          padding: 0.25rem 0.4rem;
          box-shadow: 0 1px 3px rgba(24, 50, 58, 0.08);
          max-width: calc(100% - 1rem);
          pointer-events: auto;
        }
        .facility-filter-pill {
          display: inline-flex;
          align-items: center;
          gap: 0.25rem;
          font-size: 0.78rem;
          padding: 0.2rem 0.5rem;
          border-radius: 4px;
          border: 1px solid var(--beton);
          background: var(--hujan-pagi);
          color: var(--tinta-kota);
          font-weight: 600;
          cursor: pointer;
          line-height: 1.3;
          touch-action: manipulation;
          transition: background-color 0.15s ease, color 0.15s ease, border-color 0.15s ease;
        }
        .facility-filter-pill:hover {
          background: var(--beton);
          border-color: var(--quiet-ink);
        }
        .facility-filter-pill--active {
          background: var(--kali-teal);
          border-color: var(--kali-teal);
          color: #FFFFFF;
        }
        .facility-filter-pill--active:hover {
          background: var(--kali-teal);
          border-color: var(--kali-teal);
        }
        .facility-filter-pill:focus-visible,
        .map-tool-btn:focus-visible {
          outline: 2px solid var(--kali-teal);
          outline-offset: 1px;
        }
        .map-zoom-controls {
          position: absolute;
          bottom: 0.5rem;
          right: 0.5rem;
          z-index: 5;
          display: flex;
          align-items: center;
          gap: 2px;
          background: var(--surface);
          border: 1px solid var(--beton);
          border-radius: 6px;
          padding: 2px;
          box-shadow: 0 1px 3px rgba(24, 50, 58, 0.08);
          pointer-events: auto;
        }
        .map-tool-btn {
          width: 28px;
          height: 28px;
          border: 0;
          border-radius: 4px;
          background: transparent;
          color: var(--tinta-kota);
          font-size: 0.95rem;
          font-weight: bold;
          cursor: pointer;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          touch-action: manipulation;
          transition: background-color 0.15s ease;
        }
        .map-tool-btn:hover {
          background: var(--hujan-pagi);
        }
        .map-tool-btn--recenter {
          width: auto;
          height: 28px;
          padding: 0 0.5rem;
          border-left: 1px solid var(--beton);
          border-radius: 0 4px 4px 0;
          color: var(--kali-teal);
          font-size: 0.78rem;
          font-weight: 600;
        }
        .map-tool-btn--recenter:hover {
          background: var(--hujan-pagi);
        }
        .nearby-facilities-details {
          margin-top: 0.5rem;
          padding: 0.5rem 0.75rem;
          background: var(--soft-panel);
          border: 1px solid var(--beton);
          border-radius: 6px;
          font-size: 0.85rem;
        }
        .nearby-facilities-summary {
          cursor: pointer;
          font-weight: 600;
          color: var(--tinta-kota);
        }
        .nearby-facilities-grid {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
          gap: 0.4rem;
          margin-top: 0.5rem;
        }
        .nearby-facility-card {
          padding: 0.35rem 0.5rem;
          background: var(--surface);
          border: 1px solid var(--beton);
          border-radius: 4px;
          cursor: pointer;
          transition: background-color 0.15s ease, border-color 0.15s ease;
        }
        .nearby-facility-card:hover {
          background: var(--hujan-pagi);
          border-color: var(--kali-teal);
        }
        .nearby-facility-title {
          font-weight: 600;
          color: var(--tinta-kota);
        }
        .nearby-facility-meta {
          color: var(--quiet-ink);
          font-size: 0.78rem;
        }
        @media (max-width: 480px) {
          .map-facility-filters {
            gap: 0.2rem;
            padding: 0.2rem 0.3rem;
          }
          .facility-filter-pill {
            font-size: 0.72rem;
            padding: 0.18rem 0.4rem;
          }
        }
      `}</style>
      <div
        className="interactive-incident-map"
        data-testid="interactive-incident-map"
        ref={containerRef}
        style={{
          height: `${mapHeight}px`,
          cursor: isDragging ? "grabbing" : "grab",
        }}
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
          {/* Affected Area Circle */}
          {incidentCanvasPx && (
            <g className="map-affected-area-group">
              <circle
                cx={incidentCanvasPx.x}
                cy={incidentCanvasPx.y}
                r={radiusPixels}
                fill="var(--kali-teal)"
                fillOpacity={0.08}
                stroke="var(--kali-teal)"
                strokeWidth={2}
                strokeDasharray="4 3"
                className="map-affected-radius"
              />
              <g
                transform={`translate(${incidentCanvasPx.x}, ${incidentCanvasPx.y + radiusPixels + 6})`}
                className="map-radius-badge"
              >
                <rect
                  x="-52"
                  y="-9"
                  width="104"
                  height="18"
                  rx="9"
                  fill="var(--tinta-kota)"
                  stroke="var(--beton)"
                  strokeWidth={1}
                />
                <text
                  x="0"
                  y="4"
                  textAnchor="middle"
                  fill="#FFFFFF"
                  fontSize="11"
                  fontWeight="600"
                >
                  Radius: {radiusMeters} m
                </text>
              </g>
            </g>
          )}

          {/* Clean Facility Pins (Icons without overlapping text clutter) */}
          <g className="map-facilities-group">
            {filteredFacilities.map((facility) => {
              const pos = projectPoint(facility.coordinates);
              if (pos.x < -30 || pos.x > width + 30 || pos.y < -30 || pos.y > mapHeight + 30) {
                return null;
              }
              const isSelected = activeSelectedId === facility.id;
              const badgeBg =
                facility.kind === "hospital"
                  ? "var(--merah-tanda)"
                  : facility.kind === "police"
                  ? "var(--kali-teal)"
                  : "var(--kuning-perhatian)";

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
                    fill={badgeBg}
                    stroke="#FFFFFF"
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
                fill="none"
                stroke="var(--merah-tanda)"
                strokeWidth="2"
                opacity="0.6"
              />
              <circle
                cx="0"
                cy="0"
                r="14"
                className="incident-beacon-inner"
                fill="none"
                stroke="var(--merah-tanda)"
                strokeWidth="1.5"
                opacity="0.8"
              />
              <circle
                cx="0"
                cy="0"
                r="11"
                className="incident-beacon-core"
                fill="var(--merah-tanda)"
                stroke="#FFFFFF"
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
                  fill="var(--tinta-kota)"
                  stroke="var(--beton)"
                  strokeWidth="1"
                />
                <text
                  x="0"
                  y="2"
                  textAnchor="middle"
                  fill="#FFFFFF"
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
            className={`facility-filter-pill ${activeFacilityFilter === "all" ? "facility-filter-pill--active" : ""}`}
            onClick={() => setActiveFacilityFilter("all")}
            aria-pressed={activeFacilityFilter === "all"}
            title="Semua Fasilitas"
            aria-label="Filter semua fasilitas"
          >
            Semua Fasilitas ({nearbyFacilities.length})
          </button>
          <button
            type="button"
            className={`facility-filter-pill ${activeFacilityFilter === "hospital" ? "facility-filter-pill--active" : ""}`}
            onClick={() => setActiveFacilityFilter("hospital")}
            aria-pressed={activeFacilityFilter === "hospital"}
            title="Rumah Sakit"
            aria-label="Filter rumah sakit"
          >
            🏥 RS ({facilityCounts.hospital})
          </button>
          <button
            type="button"
            className={`facility-filter-pill ${activeFacilityFilter === "police" ? "facility-filter-pill--active" : ""}`}
            onClick={() => setActiveFacilityFilter("police")}
            aria-pressed={activeFacilityFilter === "police"}
            title="Kepolisian"
            aria-label="Filter kepolisian"
          >
            👮 Polisi ({facilityCounts.police})
          </button>
          <button
            type="button"
            className={`facility-filter-pill ${activeFacilityFilter === "fire_station" ? "facility-filter-pill--active" : ""}`}
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
