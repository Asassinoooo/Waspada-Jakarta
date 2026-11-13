import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject } from "react";
import {
  coordinateToWorldPixels,
  createOsmTileUrl,
  getVisibleMapTiles,
  worldPixelsToCoordinate,
  type MapCoordinate,
} from "./SourcePointMap.js";
import { facilityKindIcon, facilityKindLabel, type EmergencyFacility } from "./emergency-facilities.js";

// Browser-only, like the other page stylesheets: keeps the module importable under Node SSR tests.
// The tile, zoom-control and pin rules live in incident-map.css, which the old incident map used to load.
if (typeof document !== "undefined") {
  void import("./incident-map.css");
}

export interface MapView {
  center: MapCoordinate;
  zoom: number;
}

/** Jakarta at city scale. Recentering returns here. */
export const MAP_DEFAULT_VIEW: MapView = { center: [106.8456, -6.2088], zoom: 12 };
/** Zoom used when the map centres on one event. */
export const MAP_DETAIL_ZOOM = 15;
export const MAP_MIN_ZOOM = 10;
export const MAP_MAX_ZOOM = 18;

const TILE_TEMPLATE = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
const FALLBACK_SIZE = { width: 640, height: 480 };
const DRAG_THRESHOLD_PX = 4;
const EDGE_MARGIN_PX = 24;

export interface MapProjection {
  project: (coordinate: MapCoordinate) => { x: number; y: number };
  width: number;
  height: number;
}

export interface CanvasMarker {
  id: string;
  coordinate: MapCoordinate;
  label: string;
  icon: string;
  selected: boolean;
}

export interface EventMapCanvasProps {
  label: string;
  view: MapView;
  onViewChange: (view: MapView) => void;
  markers: readonly CanvasMarker[];
  onSelectMarker: (id: string, element: HTMLElement) => void;
  facilities: readonly EmergencyFacility[];
  showRecenter: boolean;
  onRecenter: () => void;
  /** Overlay for the popup. It receives the same projection the markers use. */
  renderOverlay?: (projection: MapProjection) => ReactNode;
}

export function clampZoom(zoom: number): number {
  return Math.min(MAP_MAX_ZOOM, Math.max(MAP_MIN_ZOOM, zoom));
}

export function isDefaultMapView(view: MapView): boolean {
  return view.zoom === MAP_DEFAULT_VIEW.zoom
    && view.center[0] === MAP_DEFAULT_VIEW.center[0]
    && view.center[1] === MAP_DEFAULT_VIEW.center[1];
}

function useElementSize(ref: RefObject<HTMLElement | null>): { width: number; height: number } {
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const update = () => {
      const rect = element.getBoundingClientRect();
      const next = { width: Math.round(rect.width), height: Math.round(rect.height) };
      setSize((current) => (current.width === next.width && current.height === next.height ? current : next));
    };
    update();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", update);
      return () => window.removeEventListener("resize", update);
    }
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return size;
}

interface DragState {
  pointerId: number;
  x: number;
  y: number;
  center: { x: number; y: number };
  moved: boolean;
}

/**
 * Slippy map on the shared Web Mercator helpers. Tiles are OSM raster images, and markers are real
 * buttons so they take keyboard focus. A drag pans only after 4px of movement, so a tap still
 * selects a marker.
 */
export function EventMapCanvas({
  label,
  view,
  onViewChange,
  markers,
  onSelectMarker,
  facilities,
  showRecenter,
  onRecenter,
  renderOverlay,
}: EventMapCanvasProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const measured = useElementSize(containerRef);
  const width = measured.width > 0 ? measured.width : FALLBACK_SIZE.width;
  const height = measured.height > 0 ? measured.height : FALLBACK_SIZE.height;
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<DragState | null>(null);

  const centerPixels = coordinateToWorldPixels(view.center, view.zoom);
  const project = (coordinate: MapCoordinate) => {
    const point = coordinateToWorldPixels(coordinate, view.zoom);
    return { x: width / 2 + (point.x - centerPixels.x), y: height / 2 + (point.y - centerPixels.y) };
  };
  const tiles = getVisibleMapTiles(width, height, view.center, view.zoom);

  // After a zoom, keep the tiles that were on screen at the previous zoom (already in the browser
  // cache), scaled into the new view, underneath the new tiles. The map no longer flashes blank
  // while the new zoom level downloads. Only tiles that were already shown are reused, so this
  // adds no tile requests.
  const lastViewRef = useRef<MapView>(view);
  const [backdropView, setBackdropView] = useState<MapView | null>(null);
  useLayoutEffect(() => {
    const last = lastViewRef.current;
    if (last.zoom !== view.zoom) setBackdropView(last);
    lastViewRef.current = view;
  }, [view]);
  const backdropTiles = backdropView === null || backdropView.zoom === view.zoom
    ? []
    : getVisibleMapTiles(width, height, backdropView.center, backdropView.zoom).map((tile) => {
      const scale = 2 ** (view.zoom - tile.zoom);
      const size = 256 * scale;
      return {
        key: `backdrop-${tile.key}`,
        src: createOsmTileUrl(TILE_TEMPLATE, tile),
        left: Math.round(tile.x * size - (centerPixels.x - width / 2)),
        top: Math.round(tile.y * size - (centerPixels.y - height / 2)),
        size: Math.round(size),
      };
    }).filter((tile) => tile.left < width && tile.top < height && tile.left + tile.size > 0 && tile.top + tile.size > 0);
  const insideMarginBox = (point: { x: number; y: number }, margin: number) =>
    point.x >= -margin && point.x <= width + margin && point.y >= -margin && point.y <= height + margin;

  function onPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    dragRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, center: centerPixels, moved: false };
  }

  function onPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    if (!drag.moved) {
      if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
      drag.moved = true;
      event.currentTarget.setPointerCapture(event.pointerId);
      setDragging(true);
    }
    onViewChange({
      center: worldPixelsToCoordinate(drag.center.x - dx, drag.center.y - dy, view.zoom),
      zoom: view.zoom,
    });
  }

  function endDrag(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (drag.moved) {
      setDragging(false);
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    dragRef.current = null;
  }

  const stopPointer = (event: ReactPointerEvent<HTMLElement>) => event.stopPropagation();

  return (
    <div
      ref={containerRef}
      className={`interactive-incident-map event-map-canvas${dragging ? " interactive-incident-map--dragging" : ""}`}
      role="region"
      aria-label={label}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
    >
      <div className="map-tile-layer" style={{ left: 0, top: 0, width, height }}>
        {backdropTiles.map((tile) => (
          <img
            key={tile.key}
            src={tile.src}
            alt=""
            draggable={false}
            className="map-tile-img map-tile-img--backdrop"
            style={{ left: tile.left, top: tile.top, width: tile.size, height: tile.size }}
          />
        ))}
        {tiles.map((tile) => (
          <img
            key={tile.key}
            src={createOsmTileUrl(TILE_TEMPLATE, tile)}
            alt=""
            draggable={false}
            decoding="async"
            className="map-tile-img"
            style={{ left: Math.round(tile.left), top: Math.round(tile.top) }}
          />
        ))}
      </div>

      <div className="map-marker-layer">
        {facilities.map((facility) => {
          const point = project(facility.coordinates);
          if (!insideMarginBox(point, EDGE_MARGIN_PX)) return null;
          return (
            <span
              key={facility.id}
              role="img"
              aria-label={`${facilityKindLabel(facility.kind)}: ${facility.title}`}
              className={`map-facility facility-pin facility-pin--${facility.kind}`}
              style={{ left: point.x, top: point.y }}
            >
              <svg className="map-facility__svg" viewBox="-12 -12 24 24" aria-hidden="true" focusable="false">
                <circle className="facility-pin-circle" r="8" strokeWidth="1.5" />
                <text className="facility-pin-emoji" textAnchor="middle" y="3" fontSize="8">
                  {facilityKindIcon(facility.kind)}
                </text>
              </svg>
            </span>
          );
        })}
        {markers.map((marker) => {
          const point = project(marker.coordinate);
          if (!insideMarginBox(point, EDGE_MARGIN_PX)) return null;
          return (
            <button
              key={marker.id}
              type="button"
              className={`map-marker${marker.selected ? " map-marker--selected" : ""}`}
              style={{ left: point.x, top: point.y }}
              aria-label={marker.label}
              aria-pressed={marker.selected}
              onClick={(event) => onSelectMarker(marker.id, event.currentTarget)}
            >
              <svg className="map-marker__svg" viewBox="-22 -22 44 44" aria-hidden="true" focusable="false">
                {marker.selected && <circle className="map-marker__ring" r="20" />}
                <circle className="incident-beacon-core" r="11" strokeWidth="2" />
                <text className="map-marker__icon" textAnchor="middle" y="4" fontSize="10">{marker.icon}</text>
              </svg>
            </button>
          );
        })}
      </div>

      {renderOverlay && (
        <div className="map-overlay-layer" onPointerDown={stopPointer}>
          {renderOverlay({ project, width, height })}
        </div>
      )}

      <div className="map-zoom-controls" role="group" aria-label="Kontrol navigasi peta" onPointerDown={stopPointer}>
        <button
          type="button"
          className="map-tool-btn"
          title="Perbesar"
          aria-label="Perbesar peta"
          disabled={view.zoom >= MAP_MAX_ZOOM}
          onClick={() => onViewChange({ center: view.center, zoom: clampZoom(view.zoom + 1) })}
        >
          +
        </button>
        <button
          type="button"
          className="map-tool-btn"
          title="Perkecil"
          aria-label="Perkecil peta"
          disabled={view.zoom <= MAP_MIN_ZOOM}
          onClick={() => onViewChange({ center: view.center, zoom: clampZoom(view.zoom - 1) })}
        >
          −
        </button>
        {showRecenter && (
          <button
            type="button"
            className="map-tool-btn map-tool-btn--recenter"
            title="Kembali ke tampilan awal Jakarta"
            aria-label="Pusatkan kembali ke Jakarta"
            onClick={onRecenter}
          >
            Pusatkan
          </button>
        )}
      </div>

      <p className="map-attribution">© OpenStreetMap contributors</p>
    </div>
  );
}
