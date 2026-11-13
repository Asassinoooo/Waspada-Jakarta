/**
 * Continuous (fractional) zoom and camera motion for the map home (MAP-UX-02).
 *
 * The shared SourcePointMap helpers round the zoom to whole tile levels. A pinch or a fly animation
 * needs the levels in between, so these helpers use the same Web Mercator maths with a fractional
 * zoom. Tiles are still drawn at a whole level and scaled (see EventMapCanvas).
 */

export type MapCoordinate = readonly [longitude: number, latitude: number];

export interface MapView {
  center: MapCoordinate;
  zoom: number;
}

export interface ScreenPoint {
  x: number;
  y: number;
}

const TILE_SIZE = 256;
const MAX_MERCATOR_LATITUDE = 85.0511287798066;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function worldSize(zoom: number): number {
  return TILE_SIZE * 2 ** zoom;
}

/** World pixel position at a fractional zoom. */
export function worldAt(coordinate: MapCoordinate, zoom: number): ScreenPoint {
  const size = worldSize(zoom);
  const longitude = clamp(coordinate[0], -180, 180);
  const latitude = clamp(coordinate[1], -MAX_MERCATOR_LATITUDE, MAX_MERCATOR_LATITUDE);
  const sine = Math.sin((latitude * Math.PI) / 180);
  return {
    x: ((longitude + 180) / 360) * size,
    y: (0.5 - Math.log((1 + sine) / (1 - sine)) / (4 * Math.PI)) * size,
  };
}

/** Inverse of `worldAt`. */
export function coordinateAt(x: number, y: number, zoom: number): MapCoordinate {
  const size = worldSize(zoom);
  const boundedX = clamp(x, 0, size);
  const boundedY = clamp(y, 0, size);
  const longitude = (boundedX / size) * 360 - 180;
  const mercator = Math.PI * (1 - (2 * boundedY) / size);
  return [longitude, (Math.atan(Math.sinh(mercator)) * 180) / Math.PI];
}

/**
 * Zooms to `zoom` while the map point under `anchor` (a position inside the viewport) stays under it.
 * This is how a pinch or a wheel zoom feels anchored to the fingers or the cursor.
 */
export function zoomAround(view: MapView, zoom: number, anchor: ScreenPoint, width: number, height: number): MapView {
  const center = worldAt(view.center, view.zoom);
  const offsetX = anchor.x - width / 2;
  const offsetY = anchor.y - height / 2;
  const scale = 2 ** (zoom - view.zoom);
  const nextX = (center.x + offsetX) * scale - offsetX;
  const nextY = (center.y + offsetY) * scale - offsetY;
  return { center: coordinateAt(nextX, nextY, zoom), zoom };
}

/**
 * Moves the centre so that `focus` lands `offsetX` pixels right of and `offsetY` pixels below the
 * viewport centre (used to clear the floating list and leave room for the popup above a marker).
 */
export function viewWithFocusOffset(focus: MapCoordinate, zoom: number, offsetX: number, offsetY = 0): MapView {
  const point = worldAt(focus, zoom);
  return { center: coordinateAt(point.x - offsetX, point.y - offsetY, zoom), zoom };
}

export function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
}

export interface FlyPath {
  /** Animation length in milliseconds. */
  duration: number;
  /** View at progress `t` from 0 to 1. */
  at: (t: number) => MapView;
}

const RHO = Math.SQRT2;
const MIN_DURATION_MS = 280;
const MAX_DURATION_MS = 1400;
const MS_PER_PATH_UNIT = 650;

/**
 * Smooth zoom-and-pan path (van Wijk and Nuij, "Smooth and efficient zooming and panning", the
 * same curve d3-zoom and Mapbox flyTo use). Between two nearby points it is a plain pan and zoom.
 * Between distant points it zooms out, travels and zooms back in, so the user keeps their bearings.
 * Positions are in zoom-0 world pixels and `w` is the viewport width in those units.
 */
export function flyPath(from: MapView, to: MapView, viewportWidth: number): FlyPath {
  const width = Math.max(1, viewportWidth);
  const p0 = worldAt(from.center, 0);
  const p1 = worldAt(to.center, 0);
  const w0 = width / 2 ** from.zoom;
  const w1 = width / 2 ** to.zoom;
  const dx = p1.x - p0.x;
  const dy = p1.y - p0.y;
  const d2 = dx * dx + dy * dy;
  const toView = (ux: number, uy: number, w: number): MapView => ({
    center: coordinateAt(ux, uy, 0),
    zoom: Math.log2(width / w),
  });

  let pathLength: number;
  let at: (t: number) => MapView;

  if (d2 < 1e-18) {
    pathLength = Math.abs(Math.log(w1 / w0)) / RHO;
    at = (t) => toView(p0.x + t * dx, p0.y + t * dy, w0 * Math.exp(Math.log(w1 / w0) * t));
  } else {
    const d1 = Math.sqrt(d2);
    const b0 = (w1 * w1 - w0 * w0 + RHO ** 4 * d2) / (2 * w0 * RHO ** 2 * d1);
    const b1 = (w1 * w1 - w0 * w0 - RHO ** 4 * d2) / (2 * w1 * RHO ** 2 * d1);
    const r0 = Math.log(Math.sqrt(b0 * b0 + 1) - b0);
    const r1 = Math.log(Math.sqrt(b1 * b1 + 1) - b1);
    pathLength = (r1 - r0) / RHO;
    const coshR0 = Math.cosh(r0);
    const sinhR0 = Math.sinh(r0);
    at = (t) => {
      const s = t * pathLength;
      const u = (w0 / (RHO * RHO * d1)) * (coshR0 * Math.tanh(RHO * s + r0) - sinhR0);
      return toView(p0.x + u * dx, p0.y + u * dy, (w0 * coshR0) / Math.cosh(RHO * s + r0));
    };
  }

  const duration = Number.isFinite(pathLength)
    ? clamp(pathLength * MS_PER_PATH_UNIT, MIN_DURATION_MS, MAX_DURATION_MS)
    : MIN_DURATION_MS;
  // The ends are exact, so rounding never leaves the camera a hair off the target.
  return { duration, at: (t) => (t <= 0 ? from : t >= 1 ? to : at(t)) };
}
