// PERF-09: the Web Mercator tile maths is shared by the first-screen maps (MapPanel, EventMapCanvas, MapHome) and
// the administrator source map. It lives here, so the first screen does not load the admin map component.

export type MapCoordinate = readonly [longitude: number, latitude: number];

export interface VisibleMapTile {
  key: string;
  x: number;
  y: number;
  zoom: number;
  left: number;
  top: number;
}

export const TILE_SIZE = 256;
const MAX_MERCATOR_LATITUDE = 85.0511287798066;
const MIN_ZOOM = 4;
const MAX_ZOOM = 18;
const MAX_VISIBLE_TILES = 100;
const MAX_TILES_PER_AXIS = Math.floor(Math.sqrt(MAX_VISIBLE_TILES));

function clamp(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return minimum;
  return Math.min(maximum, Math.max(minimum, value));
}

export function clampMapZoom(zoom: number): number {
  return clamp(Math.round(zoom), MIN_ZOOM, MAX_ZOOM);
}

export function clusterZoomTarget(currentZoom: number): number {
  return clampMapZoom(clampMapZoom(currentZoom) + 2);
}

function worldSizeAtZoom(zoom: number): number {
  return TILE_SIZE * 2 ** clampMapZoom(zoom);
}

export function coordinateToWorldPixels(coordinate: MapCoordinate, zoom: number): { x: number; y: number } {
  const [longitude, latitude] = coordinate;
  const worldSize = worldSizeAtZoom(zoom);
  const boundedLongitude = clamp(longitude, -180, 180);
  const boundedLatitude = clamp(latitude, -MAX_MERCATOR_LATITUDE, MAX_MERCATOR_LATITUDE);
  const sine = Math.sin((boundedLatitude * Math.PI) / 180);

  return {
    x: ((boundedLongitude + 180) / 360) * worldSize,
    y: (0.5 - Math.log((1 + sine) / (1 - sine)) / (4 * Math.PI)) * worldSize,
  };
}

export function worldPixelsToCoordinate(x: number, y: number, zoom: number): MapCoordinate {
  const worldSize = worldSizeAtZoom(zoom);
  const boundedX = clamp(x, 0, worldSize);
  const boundedY = clamp(y, 0, worldSize);
  const longitude = (boundedX / worldSize) * 360 - 180;
  const mercator = Math.PI * (1 - (2 * boundedY) / worldSize);
  const latitude = (Math.atan(Math.sinh(mercator)) * 180) / Math.PI;
  return [longitude, latitude];
}

function boundedTileAxis(first: number, last: number, centerTile: number): number[] {
  if (first > last) return [];
  const count = last - first + 1;
  const maximumCount = Math.min(MAX_TILES_PER_AXIS, count);
  const desiredFirst = Math.floor(centerTile - (maximumCount - 1) / 2);
  const boundedFirst = Math.max(first, Math.min(desiredFirst, last - maximumCount + 1));
  return Array.from({ length: maximumCount }, (_, index) => boundedFirst + index);
}

export function getVisibleMapTiles(
  width: number,
  height: number,
  center: MapCoordinate,
  zoom: number,
): VisibleMapTile[] {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return [];

  const boundedZoom = clampMapZoom(zoom);
  const tileCount = 2 ** boundedZoom;
  const centerPixels = coordinateToWorldPixels(center, boundedZoom);
  const left = centerPixels.x - width / 2;
  const top = centerPixels.y - height / 2;
  const right = centerPixels.x + width / 2;
  const bottom = centerPixels.y + height / 2;
  const epsilon = 1e-7;

  const firstX = Math.max(0, Math.floor(left / TILE_SIZE));
  const lastX = Math.min(tileCount - 1, Math.floor((right - epsilon) / TILE_SIZE));
  const firstY = Math.max(0, Math.floor(top / TILE_SIZE));
  const lastY = Math.min(tileCount - 1, Math.floor((bottom - epsilon) / TILE_SIZE));
  const xTiles = boundedTileAxis(firstX, lastX, centerPixels.x / TILE_SIZE);
  const yTiles = boundedTileAxis(firstY, lastY, centerPixels.y / TILE_SIZE);
  const tiles: VisibleMapTile[] = [];

  for (const y of yTiles) {
    for (const x of xTiles) {
      if (x < 0 || y < 0 || x >= tileCount || y >= tileCount) continue;
      const tileLeft = x * TILE_SIZE - left;
      const tileTop = y * TILE_SIZE - top;
      if (tileLeft >= width || tileTop >= height || tileLeft + TILE_SIZE <= 0 || tileTop + TILE_SIZE <= 0) continue;
      tiles.push({ key: `${boundedZoom}/${x}/${y}`, x, y, zoom: boundedZoom, left: tileLeft, top: tileTop });
    }
  }

  return tiles.slice(0, MAX_VISIBLE_TILES);
}

export function isValidOsmTileTemplate(template: string): boolean {
  if (template.length === 0 || template.length > 512 || template.trim() !== template) return false;
  for (const placeholder of ["{z}", "{x}", "{y}"]) {
    if (template.split(placeholder).length !== 2) return false;
  }
  const remainder = template.replaceAll("{z}", "").replaceAll("{x}", "").replaceAll("{y}", "");
  if (/[{}]/.test(remainder)) return false;

  try {
    const probeUrl = new URL(template.replace("{z}", "1").replace("{x}", "1").replace("{y}", "1"));
    return probeUrl.protocol === "https:" &&
      probeUrl.hostname.length > 0 &&
      probeUrl.username === "" &&
      probeUrl.password === "" &&
      probeUrl.search === "" &&
      probeUrl.hash === "";
  } catch {
    return false;
  }
}

export function createOsmTileUrl(template: string, tile: Pick<VisibleMapTile, "x" | "y" | "zoom">): string {
  if (!isValidOsmTileTemplate(template)) throw new TypeError("OSM tile template must be a credential-free HTTPS XYZ URL");
  return template.replace("{z}", String(tile.zoom)).replace("{x}", String(tile.x)).replace("{y}", String(tile.y));
}
