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
const DEFAULT_VIEWPORT_SIZE = { width: 780, height: 480 };

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
    case "flood":
      return "🌊";
    case "fire":
      return "🔥";
    case "accident":
      return "🚗";
    case "tree_fall":
      return "🌳";
    case "crime":
      return "🚨";
    case "weather":
      return "⛈️";
    default:
      return "⚠️";
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
      return 300;
    default:
      return 500;
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
  activeQuote,
  tileTemplate = "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
  height = 480,
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

  // Sync center when coordinates change
  useEffect(() => {
    setCenter(effectiveCenter);
    setZoom(DEFAULT_ZOOM);
  }, [effectiveCenter]);

  // Radius calculation
  const radiusMeters = useMemo(
    () => calculateAffectedRadiusMeters(severity, incidentType),
    [severity, incidentType]
  );

  const radiusPixels = useMemo(() => {
    const lat = center[1];
    return metersToPixels(radiusMeters, lat, zoom);
  }, [radiusMeters, center, zoom]);

  // Nearby emergency facilities from 200 registry
  const nearbyFacilities = useMemo(() => {
    return findNearbyFacilities(effectiveCenter, 5000, 30);
  }, [effectiveCenter]);

  // Counts by kind
  const facilityCounts = useMemo(() => {
    const counts = { hospital: 0, police: 0, fire_station: 0 };
    for (const f of nearbyFacilities) {
      counts[f.kind] = (counts[f.kind] || 0) + 1;
    }
    return counts;
  }, [nearbyFacilities]);

  // Filtered facilities
  const filteredFacilities = useMemo(() => {
    if (activeFacilityFilter === "all") return nearbyFacilities;
    return nearbyFacilities.filter((f) => f.kind === activeFacilityFilter);
  }, [nearbyFacilities, activeFacilityFilter]);

  const width = DEFAULT_VIEWPORT_SIZE.width;
  const mapHeight = height;

  // Project center to world pixels
  const centerWorldPx = useMemo(() => {
    return coordinateToWorldPixels(center, zoom);
  }, [center, zoom]);

  // Project point to canvas pixels
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

  // Projected incident coordinate
  const incidentCanvasPx = useMemo(() => {
    if (!coordinates) return null;
    return projectPoint(coordinates);
  }, [coordinates, projectPoint]);

  // Visible tiles
  const tiles: VisibleMapTile[] = useMemo(() => {
    return getVisibleMapTiles(width, mapHeight, center, zoom);
  }, [width, mapHeight, center, zoom]);

  // Pan / Zoom Controls
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

  // Pointer drag panning
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
    <div
      className="interactive-incident-map"
      data-testid="interactive-incident-map"
      ref={containerRef}
      style={{
        position: "relative",
        width: "100%",
        height: `${mapHeight}px`,
        borderRadius: "12px",
        overflow: "hidden",
        backgroundColor: "#09131b",
        border: "1px solid rgba(13, 148, 136, 0.35)",
        boxShadow: "0 6px 24px rgba(0, 0, 0, 0.25)",
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
      {/* 1. Basemap Tile Layer */}
      <div
        className="map-tile-layer"
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          width: "100%",
          height: "100%",
          pointerEvents: "none",
          filter: "brightness(0.85) contrast(1.1) saturate(0.9)",
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

      {/* 2. SVG Geometries & Pins Layer */}
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
        <defs>
          <radialGradient id="affectedAreaGradient" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#0d9488" stopOpacity="0.32" />
            <stop offset="70%" stopColor="#0d9488" stopOpacity="0.14" />
            <stop offset="100%" stopColor="#0d9488" stopOpacity="0.02" />
          </radialGradient>

          <filter id="glowEffect" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="3" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        {/* Affected Area Radius Circle */}
        {incidentCanvasPx && (
          <g className="map-affected-area-group">
            <circle
              cx={incidentCanvasPx.x}
              cy={incidentCanvasPx.y}
              r={radiusPixels}
              fill="url(#affectedAreaGradient)"
              stroke="#0d9488"
              strokeWidth="2.5"
              strokeDasharray="6 4"
              className="map-affected-radius"
            />
            <circle
              cx={incidentCanvasPx.x}
              cy={incidentCanvasPx.y}
              r={Math.max(10, radiusPixels * 0.5)}
              fill="none"
              stroke="#0d9488"
              strokeWidth="1"
              strokeDasharray="2 3"
              strokeOpacity="0.6"
            />
            {/* Radius label badge */}
            <g
              transform={`translate(${incidentCanvasPx.x}, ${
                incidentCanvasPx.y + radiusPixels + 8
              })`}
              className="map-radius-badge"
            >
              <rect
                x="-64"
                y="-10"
                width="128"
                height="20"
                rx="10"
                fill="#042f2e"
                stroke="#14b8a6"
                strokeWidth="1"
              />
              <text
                x="0"
                y="4"
                textAnchor="middle"
                fill="#ccfbf1"
                fontSize="11"
                fontWeight="600"
              >
                Radius: {radiusMeters} m
              </text>
            </g>
          </g>
        )}

        {/* Nearby Emergency Facility Pins */}
        <g className="map-facilities-group" style={{ pointerEvents: "auto" }}>
          {filteredFacilities.map((facility) => {
            const pos = projectPoint(facility.coordinates);
            if (pos.x < -40 || pos.x > width + 40 || pos.y < -40 || pos.y > mapHeight + 40) {
              return null;
            }
            const isSelected = activeSelectedId === facility.id;
            const badgeBg =
              facility.kind === "hospital"
                ? "#dc2626"
                : facility.kind === "police"
                ? "#2563eb"
                : "#ea580c";

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
                role="button"
                tabIndex={0}
                aria-label={`${facilityKindLabel(facility.kind)}: ${facility.title} (${
                  facility.distanceMeters
                }m)`}
              >
                <circle
                  cx="0"
                  cy="0"
                  r={isSelected ? 16 : 12}
                  fill={badgeBg}
                  stroke={isSelected ? "#ffffff" : "rgba(255, 255, 255, 0.85)"}
                  strokeWidth={isSelected ? "3" : "1.5"}
                  filter="drop-shadow(0 2px 4px rgba(0,0,0,0.5))"
                  className="facility-pin-circle"
                />
                <text
                  cx="0"
                  cy="4"
                  textAnchor="middle"
                  fontSize={isSelected ? "13" : "10"}
                  className="facility-pin-emoji"
                >
                  {facilityKindIcon(facility.kind)}
                </text>
                <text
                  cx="0"
                  cy="20"
                  textAnchor="middle"
                  fill="#ffffff"
                  fontSize="9"
                  fontWeight="600"
                  stroke="#0f172a"
                  strokeWidth="2.5"
                  paintOrder="stroke"
                  className="facility-pin-label"
                >
                  {facility.distanceMeters}m
                </text>
                <title>{`${facility.title} (${facility.distanceMeters} m) · ${facilityKindLabel(
                  facility.kind
                )}`}</title>
              </g>
            );
          })}
        </g>

        {/* Animated Incident Pin Marker */}
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
              r="34"
              className="incident-beacon-pulse"
              fill="none"
              stroke="#ef4444"
              strokeWidth="2.5"
              opacity="0.8"
            />
            <circle
              cx="0"
              cy="0"
              r="20"
              className="incident-beacon-inner"
              fill="none"
              stroke="#f97316"
              strokeWidth="2"
              opacity="0.9"
            />
            <circle
              cx="0"
              cy="0"
              r="14"
              className="incident-beacon-core"
              fill="#ef4444"
              stroke="#ffffff"
              strokeWidth="2.5"
              filter="url(#glowEffect)"
            />
            <text
              cx="0"
              cy="5"
              textAnchor="middle"
              fontSize="12"
              className="incident-pin-icon"
            >
              {incidentTypeIcon(incidentType)}
            </text>

            {/* Incident Title Chip on Map */}
            <g transform="translate(0, -28)" className="incident-title-chip">
              <rect
                x="-80"
                y="-18"
                width="160"
                height="22"
                rx="11"
                fill="#0f172a"
                stroke="#ef4444"
                strokeWidth="1.5"
                filter="drop-shadow(0 2px 6px rgba(0,0,0,0.6))"
              />
              <text
                x="0"
                y="-3"
                textAnchor="middle"
                fill="#f8fafc"
                fontSize="10"
                fontWeight="700"
              >
                {mapIncidentTypeLabel(incidentType)} · {mapSeverityLabel(severity)}
              </text>
            </g>
          </g>
        )}
      </svg>

      {/* 3. Top Floating Toolbar: Facility Filters & Recenter Controls */}
      <div
        className="map-top-bar"
        style={{
          position: "absolute",
          top: "10px",
          left: "10px",
          right: "10px",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: "8px",
          zIndex: 10,
          pointerEvents: "none",
        }}
      >
        {/* Facility Kind Filter Pills */}
        <div
          className="map-facility-filters"
          style={{
            display: "flex",
            gap: "4px",
            background: "rgba(15, 23, 42, 0.88)",
            padding: "4px 8px",
            borderRadius: "20px",
            border: "1px solid rgba(255, 255, 255, 0.15)",
            backdropFilter: "blur(6px)",
            pointerEvents: "auto",
          }}
        >
          <button
            type="button"
            className={`facility-filter-pill ${
              activeFacilityFilter === "all" ? "facility-filter-pill--active" : ""
            }`}
            onClick={() => setActiveFacilityFilter("all")}
            aria-pressed={activeFacilityFilter === "all"}
          >
            Semua Fasilitas ({nearbyFacilities.length})
          </button>
          <button
            type="button"
            className={`facility-filter-pill facility-filter-pill--hospital ${
              activeFacilityFilter === "hospital" ? "facility-filter-pill--active" : ""
            }`}
            onClick={() => setActiveFacilityFilter("hospital")}
            aria-pressed={activeFacilityFilter === "hospital"}
          >
            🏥 RS ({facilityCounts.hospital})
          </button>
          <button
            type="button"
            className={`facility-filter-pill facility-filter-pill--police ${
              activeFacilityFilter === "police" ? "facility-filter-pill--active" : ""
            }`}
            onClick={() => setActiveFacilityFilter("police")}
            aria-pressed={activeFacilityFilter === "police"}
          >
            👮 Polisi ({facilityCounts.police})
          </button>
          <button
            type="button"
            className={`facility-filter-pill facility-filter-pill--fire ${
              activeFacilityFilter === "fire_station" ? "facility-filter-pill--active" : ""
            }`}
            onClick={() => setActiveFacilityFilter("fire_station")}
            aria-pressed={activeFacilityFilter === "fire_station"}
          >
            🚒 Damkar ({facilityCounts.fire_station})
          </button>
        </div>

        {/* Map Pan / Zoom & Action Buttons */}
        <div
          className="map-nav-tools"
          style={{
            display: "flex",
            gap: "4px",
            background: "rgba(15, 23, 42, 0.88)",
            padding: "4px 6px",
            borderRadius: "8px",
            border: "1px solid rgba(255, 255, 255, 0.15)",
            backdropFilter: "blur(6px)",
            pointerEvents: "auto",
          }}
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
            🎯 Pusatkan
          </button>
        </div>
      </div>

      {/* Active Citation Badge (if focused by quote) */}
      {activeQuote && (
        <div
          className="map-active-quote-chip"
          style={{
            position: "absolute",
            top: "52px",
            left: "12px",
            maxWidth: "320px",
            background: "rgba(13, 148, 136, 0.95)",
            color: "#ffffff",
            padding: "4px 10px",
            borderRadius: "6px",
            fontSize: "0.78rem",
            boxShadow: "0 2px 8px rgba(0,0,0,0.3)",
            zIndex: 10,
            pointerEvents: "none",
          }}
        >
          Fokus Kutipan: <em>"{activeQuote.slice(0, 50)}…"</em>
        </div>
      )}

      {/* 4. Bottom Selected Facility Detail Bar */}
      {selectedFacility && (
        <div
          className="map-facility-detail-card"
          style={{
            position: "absolute",
            bottom: "12px",
            left: "12px",
            right: "12px",
            background: "rgba(15, 23, 42, 0.94)",
            border: "1px solid #14b8a6",
            borderRadius: "8px",
            padding: "8px 14px",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            backdropFilter: "blur(8px)",
            color: "#f8fafc",
            zIndex: 10,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <span style={{ fontSize: "1.25rem" }}>
              {facilityKindIcon(selectedFacility.kind)}
            </span>
            <div>
              <strong style={{ display: "block", fontSize: "0.88rem" }}>
                {selectedFacility.title}
              </strong>
              <span style={{ fontSize: "0.78rem", color: "#94a3b8" }}>
                {facilityKindLabel(selectedFacility.kind)} · Jarak:{" "}
                <span style={{ color: "#2dd4bf", fontWeight: "600" }}>
                  {selectedFacility.distanceMeters} meter
                </span>{" "}
                dari pusat insiden ({locationLabel})
              </span>
            </div>
          </div>
          <button
            type="button"
            onClick={() => setSelectedFacility(null)}
            style={{
              background: "transparent",
              border: "none",
              color: "#94a3b8",
              cursor: "pointer",
              fontSize: "1.2rem",
            }}
            aria-label="Tutup rincian fasilitas"
          >
            ×
          </button>
        </div>
      )}

      {/* 5. Bottom Right Map Status & Attribution */}
      <div
        className="map-attribution-badge"
        style={{
          position: "absolute",
          bottom: "6px",
          right: "8px",
          fontSize: "0.68rem",
          color: "rgba(255, 255, 255, 0.65)",
          background: "rgba(0, 0, 0, 0.5)",
          padding: "2px 6px",
          borderRadius: "4px",
          pointerEvents: "none",
        }}
      >
        © OpenStreetMap contributors · Web Mercator (EPSG:3857)
      </div>
    </div>
  );
}
