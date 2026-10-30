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
  readonly severity: "low" | "medium" | "high" | "critical";
  /** Descriptive location label */
  readonly locationLabel: string;
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
    default: return type;
  }
}

export function mapSeverityLabel(sev: string): string {
  switch (sev) {
    case "critical": return "Kritis";
    case "high": return "Tinggi";
    case "medium": return "Sedang";
    case "low": return "Rendah";
    default: return sev;
  }
}

export function incidentTypeIcon(type: string): string {
  switch (type) {
    case "flood": return "🌊";
    case "fire": return "🔥";
    case "accident": return "🚗";
    case "tree_fall": return "🌳";
    case "crime": return "🚨";
    case "weather": return "⛈️";
    default: return "⚠️";
  }
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
      <div
        className="interactive-incident-map"
        data-testid="interactive-incident-map"
        ref={containerRef}
        style={{
          position: "relative",
          width: "100%",
          height: `${mapHeight}px`,
          borderRadius: "8px",
          overflow: "hidden",
          backgroundColor: "var(--surface, #FFFFFF)",
          border: "1px solid var(--beton, #D5DEDB)",
          userSelect: "none",
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
            position: "absolute",
            left: `-${SAFE_BUFFER_X / 2}px`,
            top: `-${SAFE_BUFFER_Y / 2}px`,
            width: `${bufferWidth}px`,
            height: `${bufferHeight}px`,
            pointerEvents: "none",
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
                  position: "absolute",
                  left: `${tile.left}px`,
                  top: `${tile.top}px`,
                  width: "256px",
                  height: "256px",
                  display: "block",
                }}
              />
            );
          })}
        </div>

        {/* SVG Overlay */}
        <svg
          className="map-svg-layer"
          viewBox={`0 0 ${width} ${mapHeight}`}
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            width: "100%",
            height: "100%",
            pointerEvents: "none",
          }}
        >
          {/* Affected Area Circle */}
          {incidentCanvasPx && (
            <g className="map-affected-area-group">
              <circle
                cx={incidentCanvasPx.x}
                cy={incidentCanvasPx.y}
                r={radiusPixels}
                fill="rgba(8, 123, 117, 0.08)"
                stroke="var(--kali-teal, #087B75)"
                strokeWidth="2"
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
                  fill="var(--tinta-kota, #18323A)"
                  stroke="var(--beton, #D5DEDB)"
                  strokeWidth="1"
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
          <g className="map-facilities-group" style={{ pointerEvents: "auto" }}>
            {filteredFacilities.map((facility) => {
              const pos = projectPoint(facility.coordinates);
              if (pos.x < -30 || pos.x > width + 30 || pos.y < -30 || pos.y > mapHeight + 30) {
                return null;
              }
              const isSelected = activeSelectedId === facility.id;
              const badgeBg =
                facility.kind === "hospital"
                  ? "var(--merah-tanda, #A7433B)"
                  : facility.kind === "police"
                  ? "var(--kali-teal, #087B75)"
                  : "var(--kuning-perhatian, #E7B448)";

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
                  style={{ cursor: "pointer" }}
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
              style={{ pointerEvents: "auto", cursor: "pointer" }}
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
                stroke="var(--merah-tanda, #A7433B)"
                strokeWidth="2"
                opacity="0.6"
              />
              <circle
                cx="0"
                cy="0"
                r="14"
                className="incident-beacon-inner"
                fill="none"
                stroke="var(--merah-tanda, #A7433B)"
                strokeWidth="1.5"
                opacity="0.8"
              />
              <circle
                cx="0"
                cy="0"
                r="11"
                className="incident-beacon-core"
                fill="var(--merah-tanda, #A7433B)"
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
                  fill="var(--tinta-kota, #18323A)"
                  stroke="var(--beton, #D5DEDB)"
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

        {/* Floating Controls (Top-Left Filters, Top-Right Zoom) */}
        <div
          style={{
            position: "absolute",
            top: "8px",
            left: "8px",
            zIndex: 5,
            display: "flex",
            gap: "4px",
            background: "var(--surface, #FFFFFF)",
            border: "1px solid var(--beton, #D5DEDB)",
            borderRadius: "6px",
            padding: "3px 6px",
            boxShadow: "0 1px 3px rgba(24, 50, 58, 0.08)",
          }}
        >
          <button
            type="button"
            className={`facility-filter-pill ${activeFacilityFilter === "all" ? "facility-filter-pill--active" : ""}`}
            onClick={() => setActiveFacilityFilter("all")}
            aria-pressed={activeFacilityFilter === "all"}
            style={{
              fontSize: "0.78rem",
              padding: "0.2rem 0.5rem",
              borderRadius: "4px",
              border: "1px solid var(--beton, #D5DEDB)",
              background: activeFacilityFilter === "all" ? "var(--kali-teal, #087B75)" : "var(--hujan-pagi, #F4F7F5)",
              color: activeFacilityFilter === "all" ? "#FFFFFF" : "var(--tinta-kota, #18323A)",
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            Semua Fasilitas ({nearbyFacilities.length})
          </button>
          <button
            type="button"
            className={`facility-filter-pill ${activeFacilityFilter === "hospital" ? "facility-filter-pill--active" : ""}`}
            onClick={() => setActiveFacilityFilter("hospital")}
            aria-pressed={activeFacilityFilter === "hospital"}
            style={{
              fontSize: "0.78rem",
              padding: "0.2rem 0.5rem",
              borderRadius: "4px",
              border: "1px solid var(--beton, #D5DEDB)",
              background: activeFacilityFilter === "hospital" ? "var(--kali-teal, #087B75)" : "var(--hujan-pagi, #F4F7F5)",
              color: activeFacilityFilter === "hospital" ? "#FFFFFF" : "var(--tinta-kota, #18323A)",
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            🏥 RS ({facilityCounts.hospital})
          </button>
          <button
            type="button"
            className={`facility-filter-pill ${activeFacilityFilter === "police" ? "facility-filter-pill--active" : ""}`}
            onClick={() => setActiveFacilityFilter("police")}
            aria-pressed={activeFacilityFilter === "police"}
            style={{
              fontSize: "0.78rem",
              padding: "0.2rem 0.5rem",
              borderRadius: "4px",
              border: "1px solid var(--beton, #D5DEDB)",
              background: activeFacilityFilter === "police" ? "var(--kali-teal, #087B75)" : "var(--hujan-pagi, #F4F7F5)",
              color: activeFacilityFilter === "police" ? "#FFFFFF" : "var(--tinta-kota, #18323A)",
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            👮 Polisi ({facilityCounts.police})
          </button>
          <button
            type="button"
            className={`facility-filter-pill ${activeFacilityFilter === "fire_station" ? "facility-filter-pill--active" : ""}`}
            onClick={() => setActiveFacilityFilter("fire_station")}
            aria-pressed={activeFacilityFilter === "fire_station"}
            style={{
              fontSize: "0.78rem",
              padding: "0.2rem 0.5rem",
              borderRadius: "4px",
              border: "1px solid var(--beton, #D5DEDB)",
              background: activeFacilityFilter === "fire_station" ? "var(--kali-teal, #087B75)" : "var(--hujan-pagi, #F4F7F5)",
              color: activeFacilityFilter === "fire_station" ? "#FFFFFF" : "var(--tinta-kota, #18323A)",
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            🚒 Damkar ({facilityCounts.fire_station})
          </button>
        </div>

        {/* Zoom & Recenter Controls (Top-Right) */}
        <div
          style={{
            position: "absolute",
            top: "8px",
            right: "8px",
            zIndex: 5,
            display: "flex",
            gap: "4px",
            background: "var(--surface, #FFFFFF)",
            border: "1px solid var(--beton, #D5DEDB)",
            borderRadius: "6px",
            padding: "2px",
            boxShadow: "0 1px 3px rgba(24, 50, 58, 0.08)",
          }}
        >
          <button
            type="button"
            className="map-tool-btn"
            onClick={handleZoomIn}
            title="Perbesar"
            aria-label="Perbesar peta"
            style={{
              width: "28px",
              height: "28px",
              border: "0",
              background: "transparent",
              color: "var(--tinta-kota, #18323A)",
              fontWeight: "bold",
              cursor: "pointer",
            }}
          >
            +
          </button>
          <button
            type="button"
            className="map-tool-btn"
            onClick={handleZoomOut}
            title="Perkecil"
            aria-label="Perkecil peta"
            style={{
              width: "28px",
              height: "28px",
              border: "0",
              background: "transparent",
              color: "var(--tinta-kota, #18323A)",
              fontWeight: "bold",
              cursor: "pointer",
            }}
          >
            −
          </button>
          <button
            type="button"
            className="map-tool-btn map-tool-btn--recenter"
            onClick={handleRecenter}
            title="Pusatkan kembali ke titik insiden"
            aria-label="Pusatkan kembali ke titik insiden"
            style={{
              padding: "0 6px",
              height: "28px",
              border: "0",
              borderLeft: "1px solid var(--beton, #D5DEDB)",
              background: "transparent",
              color: "var(--kali-teal, #087B75)",
              fontSize: "0.78rem",
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            Pusatkan
          </button>
        </div>
      </div>

      {/* Clean Collapsible Nearby Facilities Details List (Underneath the map) */}
      <details
        className="nearby-facilities-details"
        style={{
          marginTop: "0.5rem",
          padding: "0.5rem 0.75rem",
          background: "var(--soft-panel, #EAF0ED)",
          border: "1px solid var(--beton, #D5DEDB)",
          borderRadius: "6px",
          fontSize: "0.85rem",
        }}
      >
        <summary style={{ cursor: "pointer", fontWeight: 600, color: "var(--tinta-kota, #18323A)" }}>
          Fasilitas Darurat Terdekat ({filteredFacilities.length} lokasi terdata)
        </summary>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))",
            gap: "0.4rem",
            marginTop: "0.5rem",
          }}
        >
          {filteredFacilities.slice(0, 8).map((f) => (
            <div
              key={f.id}
              onClick={() => handleFacilityClick(f)}
              style={{
                padding: "0.35rem 0.5rem",
                background: "var(--surface, #FFFFFF)",
                border: "1px solid var(--beton, #D5DEDB)",
                borderRadius: "4px",
                cursor: "pointer",
              }}
            >
              <div style={{ fontWeight: 600, color: "var(--tinta-kota, #18323A)" }}>
                {facilityKindIcon(f.kind)} {f.title}
              </div>
              <div style={{ color: "var(--quiet-ink, #52676B)", fontSize: "0.78rem" }}>
                {facilityKindLabel(f.kind)} · {f.distanceMeters} m
              </div>
            </div>
          ))}
        </div>
      </details>
    </div>
  );
}
