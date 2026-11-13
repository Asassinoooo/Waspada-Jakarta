import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { createOsmTileUrl, getVisibleMapTiles, type MapCoordinate } from "./SourcePointMap.js";
import { facilityKindIcon, facilityKindLabel, type EmergencyFacility } from "./emergency-facilities.js";
import {
  coordinateAt,
  easeInOutCubic,
  flyPath,
  viewWithFocusOffset,
  worldAt,
  zoomAround,
  type MapView,
  type ScreenPoint,
} from "./map-motion.js";

// Browser-only, like the other page stylesheets: keeps the module importable under Node SSR tests.
// The tile, zoom-control and pin rules live in incident-map.css, which the old incident map used to load.
if (typeof document !== "undefined") {
  void import("./incident-map.css");
}

export type { MapView } from "./map-motion.js";

/** Jakarta at city scale. Recentering returns here. */
export const MAP_DEFAULT_VIEW: MapView = { center: [106.8456, -6.2088], zoom: 12 };
/** Zoom used when the map centres on one event. */
export const MAP_DETAIL_ZOOM = 15;
export const MAP_MIN_ZOOM = 10;
export const MAP_MAX_ZOOM = 18;

const TILE_SIZE = 256;
const TILE_TEMPLATE = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
const FALLBACK_SIZE = { width: 640, height: 480 };
const DRAG_THRESHOLD_PX = 4;
const EDGE_MARGIN_PX = 24;
/** Zoom change per wheel pixel. A trackpad pinch arrives as a ctrl+wheel with small deltas, so it gets a larger factor. */
const WHEEL_ZOOM_PER_PX = 0.0025;
const PINCH_ZOOM_PER_PX = 0.012;
const WHEEL_LINE_PX = 16;

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

/**
 * Ask the map to glide to a place. A new `id` starts a new flight. `offsetX` moves the target right
 * of the centre by that many pixels, so a floating panel on the left does not cover it.
 */
export interface MapFlyRequest {
  id: number;
  center: MapCoordinate;
  zoom: number;
  offsetX?: number;
  /** Moves the target this many pixels below the centre. */
  offsetY?: number;
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
  flyRequest?: MapFlyRequest | null;
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

/** The whole tile level drawn for a fractional zoom. Tiles are scaled by at most √2 either way. */
export function tileZoomFor(zoom: number): number {
  return Math.round(clampZoom(zoom));
}

export interface PlacedTile {
  key: string;
  src: string;
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Screen rectangles for the tiles of one whole level, drawn at the current fractional zoom. Each edge
 * is rounded on its own, so neighbouring tiles share an edge exactly and no seam shows between them.
 */
export function placeTiles(
  view: MapView,
  width: number,
  height: number,
  tileZoom: number,
  source: MapView = view,
  keyPrefix = "",
): PlacedTile[] {
  const sourceScale = 2 ** (source.zoom - tileZoom);
  const covering = getVisibleMapTiles(Math.ceil(width / sourceScale), Math.ceil(height / sourceScale), source.center, tileZoom);
  const scale = 2 ** (view.zoom - tileZoom);
  const center = worldAt(view.center, view.zoom);
  const originX = center.x - width / 2;
  const originY = center.y - height / 2;
  const size = TILE_SIZE * scale;
  const placed: PlacedTile[] = [];
  for (const tile of covering) {
    const left = Math.round(tile.x * size - originX);
    const top = Math.round(tile.y * size - originY);
    const right = Math.round((tile.x + 1) * size - originX);
    const bottom = Math.round((tile.y + 1) * size - originY);
    if (right <= 0 || bottom <= 0 || left >= width || top >= height) continue;
    placed.push({
      key: `${keyPrefix}${tile.key}`,
      src: createOsmTileUrl(TILE_TEMPLATE, tile),
      left,
      top,
      width: right - left,
      height: bottom - top,
    });
  }
  return placed;
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

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined"
    && typeof window.matchMedia === "function"
    && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

interface DragState {
  pointerId: number;
  x: number;
  y: number;
  center: ScreenPoint;
  zoom: number;
  moved: boolean;
}

interface PinchState {
  distance: number;
  zoom: number;
  /** Map position under the fingers' midpoint when the pinch started, in world pixels at `zoom`. */
  anchorWorld: ScreenPoint;
}

/** Safari reports a trackpad pinch as non-standard gesture events instead of ctrl+wheel. */
type GestureLikeEvent = Event & { scale: number; clientX: number; clientY: number };

/**
 * Slippy map on Web Mercator with a continuous zoom. Tiles are OSM raster images drawn at the nearest
 * whole level and scaled, and markers are real buttons so they take keyboard focus.
 *
 * Input: drag to pan (after 4px, so a tap still selects a marker), the wheel or a trackpad pinch to
 * zoom around the cursor, two fingers to pinch on a touch screen, double-click to zoom in. Zoom
 * buttons, recentering and `flyRequest` glide along a zoom-out, pan and zoom-in path; any direct
 * input stops a glide. With reduced motion every move is a jump.
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
  flyRequest = null,
  renderOverlay,
}: EventMapCanvasProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const measured = useElementSize(containerRef);
  const width = measured.width > 0 ? measured.width : FALLBACK_SIZE.width;
  const height = measured.height > 0 ? measured.height : FALLBACK_SIZE.height;
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<DragState | null>(null);
  const pointersRef = useRef(new Map<number, ScreenPoint>());
  const pinchRef = useRef<PinchState | null>(null);
  const frameRef = useRef<number | null>(null);

  // Handlers registered once (wheel, gestures, animation frames) read the latest values from refs.
  const viewRef = useRef(view);
  viewRef.current = view;
  const onViewChangeRef = useRef(onViewChange);
  onViewChangeRef.current = onViewChange;
  const sizeRef = useRef({ width, height });
  sizeRef.current = { width, height };

  const zoom = clampZoom(view.zoom);
  const centerPixels = worldAt(view.center, zoom);
  const project = (coordinate: MapCoordinate) => {
    const point = worldAt(coordinate, zoom);
    return { x: width / 2 + (point.x - centerPixels.x), y: height / 2 + (point.y - centerPixels.y) };
  };
  const tileZoom = tileZoomFor(zoom);
  const tiles = placeTiles({ center: view.center, zoom }, width, height, tileZoom);

  // When the tile level changes, the tiles of the previous level (already loaded) stay underneath,
  // scaled into the new view, until the new level arrives. Only tiles that were on screen are reused,
  // so this adds no tile requests.
  const lastRenderedRef = useRef<{ view: MapView; tileZoom: number }>({ view, tileZoom });
  const [backdrop, setBackdrop] = useState<{ view: MapView; tileZoom: number } | null>(null);
  useLayoutEffect(() => {
    const last = lastRenderedRef.current;
    if (last.tileZoom !== tileZoom) setBackdrop(last);
    lastRenderedRef.current = { view: { center: view.center, zoom }, tileZoom };
  }, [view.center, zoom, tileZoom]);
  const backdropTiles = backdrop === null || backdrop.tileZoom === tileZoom
    ? []
    : placeTiles({ center: view.center, zoom }, width, height, backdrop.tileZoom, backdrop.view, "backdrop-");

  function commit(next: MapView) {
    const bounded = { center: next.center, zoom: clampZoom(next.zoom) };
    viewRef.current = bounded;
    onViewChangeRef.current(bounded);
  }

  function stopGlide() {
    if (frameRef.current !== null) {
      cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }
  }

  function glideTo(target: MapView) {
    stopGlide();
    const bounded = { center: target.center, zoom: clampZoom(target.zoom) };
    if (prefersReducedMotion() || typeof requestAnimationFrame !== "function") {
      commit(bounded);
      return;
    }
    const path = flyPath(viewRef.current, bounded, sizeRef.current.width);
    const start = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / path.duration);
      commit(path.at(easeInOutCubic(t)));
      frameRef.current = t < 1 ? requestAnimationFrame(step) : null;
    };
    frameRef.current = requestAnimationFrame(step);
  }

  function zoomAt(nextZoom: number, anchor: ScreenPoint) {
    const { width: w, height: h } = sizeRef.current;
    const bounded = clampZoom(nextZoom);
    if (bounded === viewRef.current.zoom) return;
    commit(zoomAround(viewRef.current, bounded, anchor, w, h));
  }

  // Glide when the parent asks for a new place.
  useEffect(() => {
    if (flyRequest === null) return;
    const targetZoom = clampZoom(flyRequest.zoom);
    const offsetX = flyRequest.offsetX ?? 0;
    const offsetY = flyRequest.offsetY ?? 0;
    // Without an offset the target is used as given, so a recenter lands exactly on the default view.
    glideTo(offsetX === 0 && offsetY === 0
      ? { center: flyRequest.center, zoom: targetZoom }
      : viewWithFocusOffset(flyRequest.center, targetZoom, offsetX, offsetY));
    // Only a new request id starts a flight; the rest of the request travels with it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flyRequest?.id]);

  useEffect(() => stopGlide, []);

  // Wheel and trackpad. React registers wheel listeners as passive, so the page would zoom instead of the map.
  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const localPoint = (clientX: number, clientY: number): ScreenPoint => {
      const rect = element.getBoundingClientRect();
      return { x: clientX - rect.left, y: clientY - rect.top };
    };
    // The popup scrolls on its own, so wheel input over it stays with the page.
    const overOverlay = (event: Event) => event.target instanceof Element && event.target.closest(".map-overlay-layer") !== null;
    const onWheel = (event: WheelEvent) => {
      if (overOverlay(event) && !event.ctrlKey) return;
      event.preventDefault();
      stopGlide();
      let delta = event.deltaY;
      if (event.deltaMode === 1) delta *= WHEEL_LINE_PX;
      else if (event.deltaMode === 2) delta *= sizeRef.current.height;
      const change = Math.max(-1, Math.min(1, -delta * (event.ctrlKey ? PINCH_ZOOM_PER_PX : WHEEL_ZOOM_PER_PX)));
      zoomAt(viewRef.current.zoom + change, localPoint(event.clientX, event.clientY));
    };
    let gestureStartZoom = viewRef.current.zoom;
    const onGestureStart = (event: Event) => {
      event.preventDefault();
      stopGlide();
      gestureStartZoom = viewRef.current.zoom;
    };
    const onGestureChange = (event: Event) => {
      event.preventDefault();
      const gesture = event as GestureLikeEvent;
      if (!(gesture.scale > 0)) return;
      zoomAt(gestureStartZoom + Math.log2(gesture.scale), localPoint(gesture.clientX, gesture.clientY));
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    element.addEventListener("gesturestart", onGestureStart);
    element.addEventListener("gesturechange", onGestureChange);
    return () => {
      element.removeEventListener("wheel", onWheel);
      element.removeEventListener("gesturestart", onGestureStart);
      element.removeEventListener("gesturechange", onGestureChange);
    };
    // Registered once; it reads the current view and size from refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function localPoint(event: { clientX: number; clientY: number }): ScreenPoint {
    const rect = containerRef.current?.getBoundingClientRect();
    return rect ? { x: event.clientX - rect.left, y: event.clientY - rect.top } : { x: width / 2, y: height / 2 };
  }

  function startDrag(pointerId: number, point: ScreenPoint, moved: boolean) {
    const current = viewRef.current;
    dragRef.current = { pointerId, x: point.x, y: point.y, center: worldAt(current.center, current.zoom), zoom: current.zoom, moved };
  }

  function startPinch() {
    const points = [...pointersRef.current.values()];
    if (points.length < 2) return;
    const [a, b] = points as [ScreenPoint, ScreenPoint];
    const current = viewRef.current;
    const center = worldAt(current.center, current.zoom);
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    pinchRef.current = {
      distance: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
      zoom: current.zoom,
      anchorWorld: { x: center.x + mid.x - width / 2, y: center.y + mid.y - height / 2 },
    };
    dragRef.current = null;
    setDragging(true);
  }

  function onPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    stopGlide();
    const point = localPoint(event);
    pointersRef.current.set(event.pointerId, point);
    if (pointersRef.current.size >= 2) {
      for (const id of pointersRef.current.keys()) {
        if (!event.currentTarget.hasPointerCapture(id)) {
          try { event.currentTarget.setPointerCapture(id); } catch { /* pointer already gone */ }
        }
      }
      startPinch();
      return;
    }
    startDrag(event.pointerId, point, false);
  }

  function onPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    if (!pointersRef.current.has(event.pointerId)) return;
    const point = localPoint(event);
    pointersRef.current.set(event.pointerId, point);

    const pinch = pinchRef.current;
    if (pinch !== null && pointersRef.current.size >= 2) {
      const [a, b] = [...pointersRef.current.values()] as [ScreenPoint, ScreenPoint];
      const distance = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
      const nextZoom = clampZoom(pinch.zoom + Math.log2(distance / pinch.distance));
      const scale = 2 ** (nextZoom - pinch.zoom);
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      // Keep the map point that started under the fingers under their current midpoint.
      const centerX = pinch.anchorWorld.x * scale - (mid.x - width / 2);
      const centerY = pinch.anchorWorld.y * scale - (mid.y - height / 2);
      commit({ center: coordinateAt(centerX, centerY, nextZoom), zoom: nextZoom });
      return;
    }

    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const dx = point.x - drag.x;
    const dy = point.y - drag.y;
    if (!drag.moved) {
      if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
      drag.moved = true;
      try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* pointer already gone */ }
      setDragging(true);
    }
    commit({ center: coordinateAt(drag.center.x - dx, drag.center.y - dy, drag.zoom), zoom: drag.zoom });
  }

  function endPointer(event: ReactPointerEvent<HTMLDivElement>) {
    if (!pointersRef.current.delete(event.pointerId)) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (pinchRef.current !== null) {
      pinchRef.current = null;
      // One finger left: carry on as a drag from where it is, without a jump.
      const remaining = [...pointersRef.current.entries()][0];
      if (remaining) startDrag(remaining[0], remaining[1], true);
      else setDragging(false);
      return;
    }
    if (dragRef.current?.pointerId === event.pointerId) {
      if (dragRef.current.moved) setDragging(false);
      dragRef.current = null;
    }
  }

  function onDoubleClick(event: ReactMouseEvent<HTMLDivElement>) {
    if ((event.target as HTMLElement).closest("button, a, input, [role='dialog']")) return;
    const { width: w, height: h } = sizeRef.current;
    glideTo(zoomAround(viewRef.current, clampZoom(Math.floor(viewRef.current.zoom) + 1), localPoint(event), w, h));
  }

  const stopPointer = (event: ReactPointerEvent<HTMLElement>) => event.stopPropagation();
  const stepZoom = (direction: 1 | -1) => {
    const current = viewRef.current.zoom;
    const next = direction > 0 ? Math.floor(current + 1e-6) + 1 : Math.ceil(current - 1e-6) - 1;
    glideTo({ center: viewRef.current.center, zoom: clampZoom(next) });
  };

  return (
    <div
      ref={containerRef}
      className={`interactive-incident-map event-map-canvas${dragging ? " interactive-incident-map--dragging" : ""}`}
      role="region"
      aria-label={label}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endPointer}
      onPointerCancel={endPointer}
      onDoubleClick={onDoubleClick}
    >
      <div className="map-tile-layer" style={{ left: 0, top: 0, width, height }}>
        {[...backdropTiles, ...tiles].map((tile) => (
          <img
            key={tile.key}
            src={tile.src}
            alt=""
            draggable={false}
            decoding="async"
            className={tile.key.startsWith("backdrop-") ? "map-tile-img map-tile-img--backdrop" : "map-tile-img"}
            style={{ left: tile.left, top: tile.top, width: tile.width, height: tile.height }}
          />
        ))}
      </div>

      <div className="map-marker-layer">
        {facilities.map((facility) => {
          const point = project(facility.coordinates);
          if (!insideMarginBox(point, width, height)) return null;
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
          if (!insideMarginBox(point, width, height)) return null;
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

      <div className="map-zoom-controls" role="group" aria-label="Kontrol navigasi peta" onPointerDown={stopPointer} onDoubleClick={(event) => event.stopPropagation()}>
        <button
          type="button"
          className="map-tool-btn"
          title="Perbesar"
          aria-label="Perbesar peta"
          disabled={zoom >= MAP_MAX_ZOOM}
          onClick={() => stepZoom(1)}
        >
          +
        </button>
        <button
          type="button"
          className="map-tool-btn"
          title="Perkecil"
          aria-label="Perkecil peta"
          disabled={zoom <= MAP_MIN_ZOOM}
          onClick={() => stepZoom(-1)}
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

function insideMarginBox(point: { x: number; y: number }, width: number, height: number): boolean {
  return point.x >= -EDGE_MARGIN_PX && point.x <= width + EDGE_MARGIN_PX && point.y >= -EDGE_MARGIN_PX && point.y <= height + EDGE_MARGIN_PX;
}
