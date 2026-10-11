import * as React from "react";
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import type { PreviewKind, PreviewRecord } from "@waspada/worker/source-preview-contracts";
import type { EarthquakeContextRecord } from "@waspada/worker/context-sources-contracts";

export type MapCoordinate = readonly [longitude: number, latitude: number];
export type SourceMapPoint = PreviewRecord | EarthquakeContextRecord;
export type SourceMapViewMode = "jakarta" | "regional_earthquakes" | "unified";

export interface VisibleMapTile {
  key: string;
  x: number;
  y: number;
  zoom: number;
  left: number;
  top: number;
}

export type SourceMapClusterSource = "osm" | "petabencana" | "usgs";
export type OsmFacilityKind = "hospital" | "police" | "fire_station";
export type OsmClusterCategoryCounts = Record<OsmFacilityKind, number>;

/** A display-only group; `anchor` is a UI placement derived from its source points. */
export interface SourceMapCluster {
  clusterId: string;
  source: SourceMapClusterSource;
  count: number;
  members: readonly SourceMapPoint[];
  memberIds: readonly string[];
  anchor: MapCoordinate;
  osmCategoryCounts: OsmClusterCategoryCounts | null;
}

export type SourceMapDisplayItem =
  | { type: "point"; key: string; point: SourceMapPoint }
  | { type: "cluster"; key: string; cluster: SourceMapCluster };

export interface SourcePointMapProps {
  points: readonly SourceMapPoint[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onReturnToList?: () => void;
  tileTemplate?: string;
  viewMode?: SourceMapViewMode;
}

const TILE_SIZE = 256;
const MAX_MERCATOR_LATITUDE = 85.0511287798066;
const INITIAL_CENTER: MapCoordinate = [106.83, -6.19];
const INITIAL_ZOOM = 12;
const REGIONAL_CENTER: MapCoordinate = [106.8, -6.8];
const REGIONAL_ZOOM = 6;
const MIN_ZOOM = 4;
const MAX_ZOOM = 18;
const MAX_VISIBLE_TILES = 100;
const MAX_TILES_PER_AXIS = Math.floor(Math.sqrt(MAX_VISIBLE_TILES));
const DEFAULT_VIEWPORT = { width: 640, height: 400 };
const DEFAULT_TILE_TEMPLATE = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
const SOURCE_MAP_CLUSTER_GRID_PX = 64;
const SOURCE_MAP_CLUSTER_MAX_ZOOM = 15;

const CATEGORY_LABELS: Record<PreviewKind | "earthquake", { letter: string; label: string }> = {
  hospital: { letter: "H", label: "Rumah sakit" },
  police: { letter: "P", label: "Kepolisian" },
  fire_station: { letter: "D", label: "Pemadam kebakaran" },
  flood_report: { letter: "B", label: "Laporan banjir" },
  earthquake: { letter: "G", label: "Episentrum gempa" },
};

interface MapView {
  center: MapCoordinate;
  zoom: number;
}

interface DragStart {
  pointerId: number;
  clientX: number;
  clientY: number;
  centerPixels: { x: number; y: number };
}

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

function tileErrorKey(template: string, tileKey: string): string {
  return JSON.stringify([template, tileKey]);
}

function isValidRecordCoordinate(point: SourceMapPoint): boolean {
  const [longitude, latitude] = point.coordinates;
  return Number.isFinite(longitude) &&
    Number.isFinite(latitude) &&
    longitude >= -180 && longitude <= 180 &&
    latitude >= -90 && latitude <= 90;
}

function selectedPointFor(points: readonly SourceMapPoint[], selectedId: string | null): SourceMapPoint | null {
  if (selectedId === null) return null;
  return points.find((point) => point.id === selectedId && isValidRecordCoordinate(point)) ?? null;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareSource(left: SourceMapClusterSource, right: SourceMapClusterSource): number {
  const order: Record<SourceMapClusterSource, number> = { osm: 0, petabencana: 1, usgs: 2 };
  return order[left] - order[right];
}

function compareMapPoints(left: SourceMapPoint, right: SourceMapPoint): number {
  return compareSource(left.source, right.source) ||
    compareText(left.id, right.id) ||
    left.coordinates[1] - right.coordinates[1] ||
    left.coordinates[0] - right.coordinates[0] ||
    compareText(left.title, right.title) ||
    compareText(left.kind, right.kind);
}

function displayItemCoordinate(item: SourceMapDisplayItem): MapCoordinate {
  return item.type === "cluster" ? item.cluster.anchor : item.point.coordinates;
}

function displayItemSource(item: SourceMapDisplayItem): SourceMapClusterSource {
  return item.type === "cluster" ? item.cluster.source : item.point.source;
}

function pointDisplayItem(point: SourceMapPoint): SourceMapDisplayItem {
  return { type: "point", key: `${point.source}:${point.id}`, point };
}

/**
 * Makes stable, provider-separated display groups for the unified source map.
 * The calculation uses fixed Web Mercator world pixels, never viewport position.
 */
export function buildSourceMapDisplayItems(
  points: readonly SourceMapPoint[],
  selectedId: string | null,
  zoom: number,
  unified: boolean,
): SourceMapDisplayItem[] {
  const validPoints = points.filter(isValidRecordCoordinate);
  if (!unified) return validPoints.map(pointDisplayItem);

  const orderedPoints = [...validPoints].sort(compareMapPoints);
  const boundedZoom = clampMapZoom(zoom);
  if (boundedZoom > SOURCE_MAP_CLUSTER_MAX_ZOOM) return orderedPoints.map(pointDisplayItem);

  const selectedPoint = selectedPointFor(validPoints, selectedId);
  const groups = new Map<string, { source: SourceMapClusterSource; column: number; row: number; members: SourceMapPoint[] }>();
  const displayItems: SourceMapDisplayItem[] = [];

  for (const point of orderedPoints) {
    if (point === selectedPoint) {
      displayItems.push(pointDisplayItem(point));
      continue;
    }

    const source = point.source;
    const pixels = coordinateToWorldPixels(point.coordinates, boundedZoom);
    const column = Math.floor(pixels.x / SOURCE_MAP_CLUSTER_GRID_PX);
    const row = Math.floor(pixels.y / SOURCE_MAP_CLUSTER_GRID_PX);
    const key = `${source}:${column}:${row}`;
    const group = groups.get(key);
    if (group) {
      group.members.push(point);
    } else {
      groups.set(key, { source, column, row, members: [point] });
    }
  }

  for (const { source, column, row, members } of groups.values()) {
    if (members.length === 1) {
      displayItems.push(pointDisplayItem(members[0]!));
      continue;
    }

    const sortedMembers = [...members].sort(compareMapPoints);
    const memberPixels = sortedMembers.map((member) => coordinateToWorldPixels(member.coordinates, boundedZoom));
    const meanPixels = memberPixels.reduce(
      (mean, pixels) => ({ x: mean.x + pixels.x / memberPixels.length, y: mean.y + pixels.y / memberPixels.length }),
      { x: 0, y: 0 },
    );
    const osmCategoryCounts: OsmClusterCategoryCounts | null = source === "osm"
      ? { hospital: 0, police: 0, fire_station: 0 }
      : null;
    if (osmCategoryCounts) {
      for (const member of sortedMembers) {
        if (member.source !== "osm") continue;
        switch (member.kind) {
          case "hospital":
            osmCategoryCounts.hospital += 1;
            break;
          case "police":
            osmCategoryCounts.police += 1;
            break;
          case "fire_station":
            osmCategoryCounts.fire_station += 1;
            break;
        }
      }
    }

    const clusterId = `display-${source}-${boundedZoom}-${column}-${row}`;
    const cluster: SourceMapCluster = {
      clusterId,
      source,
      count: sortedMembers.length,
      members: sortedMembers,
      memberIds: sortedMembers.map((member) => member.id),
      anchor: worldPixelsToCoordinate(meanPixels.x, meanPixels.y, boundedZoom),
      osmCategoryCounts,
    };
    displayItems.push({ type: "cluster", key: clusterId, cluster });
  }

  return displayItems.sort((left, right) => {
    const sourceOrder = compareSource(displayItemSource(left), displayItemSource(right));
    if (sourceOrder !== 0) return sourceOrder;
    const leftPixels = coordinateToWorldPixels(displayItemCoordinate(left), boundedZoom);
    const rightPixels = coordinateToWorldPixels(displayItemCoordinate(right), boundedZoom);
    return leftPixels.y - rightPixels.y || leftPixels.x - rightPixels.x || compareText(left.key, right.key);
  });
}

function clusterAccessibleLabel(cluster: SourceMapCluster): string {
  const source = cluster.source === "osm"
    ? "fasilitas rujukan OpenStreetMap"
    : cluster.source === "petabencana"
      ? "laporan warga PetaBencana"
      : "catatan katalog gempa USGS";
  const categoryBreakdown = cluster.osmCategoryCounts
    ? ([
      ["hospital", "rumah sakit"],
      ["police", "kepolisian"],
      ["fire_station", "pemadam kebakaran"],
    ] as const)
      .filter(([kind]) => cluster.osmCategoryCounts?.[kind] !== 0)
      .map(([kind, label]) => `${cluster.osmCategoryCounts?.[kind] ?? 0} ${label}`)
      .join(", ")
    : "";
  const breakdown = categoryBreakdown ? ` Rincian kategori: ${categoryBreakdown}.` : "";
  return `Kelompok tampilan berisi ${cluster.count} catatan ${source}.${breakdown} Jumlah ini hanya menghitung catatan yang dimuat, bukan kejadian independen, bukti penguat, tingkat bahaya, atau bahaya saat ini. Posisi kelompok adalah jangkar tampilan, bukan koordinat kejadian atau batas dampak. Tekan Enter atau Spasi untuk memperbesar peta dua tingkat.`;
}

function initialMapView(points: readonly SourceMapPoint[], selectedId: string | null, mode: SourceMapViewMode): MapView {
  const selectedPoint = selectedPointFor(points, selectedId);
  return {
    center: selectedPoint ? [selectedPoint.coordinates[0], selectedPoint.coordinates[1]] : mode === "regional_earthquakes" ? REGIONAL_CENTER : INITIAL_CENTER,
    zoom: mode === "regional_earthquakes" || (mode === "unified" && selectedPoint?.source === "usgs") ? REGIONAL_ZOOM : INITIAL_ZOOM,
  };
}

function pointDescription(point: SourceMapPoint): string {
  if (point.source === "usgs") {
    return `${point.title}, episentrum dari katalog USGS. Lokasi asal gempa; dampak di Jakarta belum ditetapkan. Titik koordinat yang diberikan sumber.`;
  }
  const category = CATEGORY_LABELS[point.kind];
  const sourceDescription = point.source === "osm"
    ? "Fasilitas referensi OpenStreetMap; ini tidak menunjukkan kesiapan atau ketersediaan layanan."
    : "Laporan warga PetaBencana yang belum ditinjau Waspada.";
  const coordinateDescription = point.coordinate_kind === "source_extent_center"
    ? "Titik tengah cakupan OSM yang diperkirakan, bukan lokasi pintu masuk gedung."
    : "Titik koordinat yang diberikan sumber.";
  return `${point.title}, ${category.label}. ${sourceDescription} ${coordinateDescription}`;
}

function eventTargetIsControl(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest("button, a, input, select, textarea") !== null;
}

export function SourcePointMap({
  points,
  selectedId,
  onSelect,
  onReturnToList,
  tileTemplate = DEFAULT_TILE_TEMPLATE,
  viewMode = "jakarta",
}: SourcePointMapProps) {
  // Keep the React binding available to the classic JSX transform used by the Node test runner.
  void React;
  const instanceId = useId();
  const titleId = `source-point-map-title-${instanceId}`;
  const helpId = `source-point-map-help-${instanceId}`;
  const regional = viewMode === "regional_earthquakes";
  const unified = viewMode === "unified";
  const LegendContainer = unified ? "details" : "div";
  const resetPlace = regional ? "wilayah gempa regional" : "Jakarta";
  const viewportRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragStart | null>(null);
  const restoreViewportFocusRef = useRef(false);
  const [view, setView] = useState<MapView>(() => initialMapView(points, selectedId, viewMode));
  const viewRef = useRef(view);
  const [viewportSize, setViewportSize] = useState(DEFAULT_VIEWPORT);
  const [tileErrors, setTileErrors] = useState<ReadonlySet<string>>(() => new Set());
  const [tileReload, setTileReload] = useState(0);
  const selectedPoint = selectedPointFor(points, selectedId);
  const selectedLongitude = selectedPoint?.coordinates[0] ?? null;
  const selectedLatitude = selectedPoint?.coordinates[1] ?? null;
  const selectedSource = selectedPoint?.source ?? null;
  const validPoints = useMemo(() => points.filter(isValidRecordCoordinate), [points]);
  const displayItems = useMemo(
    () => buildSourceMapDisplayItems(validPoints, selectedId, view.zoom, unified),
    [selectedId, unified, validPoints, view.zoom],
  );
  const templateIsValid = useMemo(() => isValidOsmTileTemplate(tileTemplate), [tileTemplate]);
  const tiles = useMemo(
    () => getVisibleMapTiles(viewportSize.width, viewportSize.height, view.center, view.zoom),
    [view.center, view.zoom, viewportSize.height, viewportSize.width],
  );
  const centerPixels = coordinateToWorldPixels(view.center, view.zoom);
  const mapOriginX = centerPixels.x - viewportSize.width / 2;
  const mapOriginY = centerPixels.y - viewportSize.height / 2;
  const displayPositions = displayItems.flatMap((item) => {
    const coordinate = displayItemCoordinate(item);
    const pixels = coordinateToWorldPixels(coordinate, view.zoom);
    const left = pixels.x - mapOriginX;
    const top = pixels.y - mapOriginY;
    const cullingMargin = item.type === "cluster" ? 42 : 36;
    if (left < -cullingMargin || top < -cullingMargin || left > viewportSize.width + cullingMargin || top > viewportSize.height + cullingMargin) return [];
    return [{ item, left, top }];
  });
  const visibleTileErrorCount = tiles.reduce(
    (count, tile) => count + Number(tileErrors.has(tileErrorKey(tileTemplate, tile.key))),
    0,
  );

  viewRef.current = view;

  useEffect(() => {
    const element = viewportRef.current;
    if (!element) return;

    const updateSize = () => {
      const rect = element.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        setViewportSize((current) => current.width === rect.width && current.height === rect.height
          ? current
          : { width: rect.width, height: rect.height });
      }
    };

    updateSize();
    if (typeof ResizeObserver !== "undefined") {
      const observer = new ResizeObserver(updateSize);
      observer.observe(element);
      return () => observer.disconnect();
    }

    window.addEventListener("resize", updateSize);
    return () => window.removeEventListener("resize", updateSize);
  }, []);

  useEffect(() => {
    updateView(initialMapView(points, selectedId, viewMode));
  }, [viewMode]);

  useEffect(() => {
    if (selectedPoint && selectedLongitude !== null && selectedLatitude !== null) {
      updateView({
        center: [selectedLongitude, selectedLatitude],
        zoom: viewMode === "unified" ? (selectedSource === "usgs" ? REGIONAL_ZOOM : INITIAL_ZOOM) : viewRef.current.zoom,
      });
    }
  }, [selectedId, selectedLongitude, selectedLatitude, selectedSource, viewMode]);

  useEffect(() => {
    if (!restoreViewportFocusRef.current) return;
    restoreViewportFocusRef.current = false;
    viewportRef.current?.focus();
  }, [view.center, view.zoom]);

  function updateView(nextView: MapView): void {
    viewRef.current = nextView;
    setView(nextView);
  }

  function zoomBy(step: number): void {
    const nextZoom = clampMapZoom(viewRef.current.zoom + step);
    if (nextZoom === viewRef.current.zoom) return;
    updateView({ ...viewRef.current, zoom: nextZoom });
  }

  function zoomIntoCluster(cluster: SourceMapCluster): void {
    const current = viewRef.current;
    restoreViewportFocusRef.current = true;
    updateView({ center: cluster.anchor, zoom: clusterZoomTarget(current.zoom) });
  }

  function centerOnSelection(): void {
    if (!selectedPoint) return;
    updateView({
      ...viewRef.current,
      center: [selectedPoint.coordinates[0], selectedPoint.coordinates[1]],
      zoom: unified ? (selectedPoint.source === "usgs" ? REGIONAL_ZOOM : INITIAL_ZOOM) : viewRef.current.zoom,
    });
  }

  function resetMap(): void {
    updateView({ center: regional ? REGIONAL_CENTER : INITIAL_CENTER, zoom: regional ? REGIONAL_ZOOM : INITIAL_ZOOM });
  }

  function showQuakeRegion(): void {
    updateView({ center: REGIONAL_CENTER, zoom: REGIONAL_ZOOM });
  }

  function panByPixels(horizontal: number, vertical: number): void {
    const current = viewRef.current;
    const worldCenter = coordinateToWorldPixels(current.center, current.zoom);
    updateView({
      ...current,
      center: worldPixelsToCoordinate(worldCenter.x + horizontal, worldCenter.y + vertical, current.zoom),
    });
  }

  function onMapKeyDown(event: ReactKeyboardEvent<HTMLDivElement>): void {
    if (event.target !== event.currentTarget) return;
    switch (event.key) {
      case "ArrowLeft":
        event.preventDefault();
        panByPixels(-80, 0);
        break;
      case "ArrowRight":
        event.preventDefault();
        panByPixels(80, 0);
        break;
      case "ArrowUp":
        event.preventDefault();
        panByPixels(0, -80);
        break;
      case "ArrowDown":
        event.preventDefault();
        panByPixels(0, 80);
        break;
      case "+":
      case "=":
        event.preventDefault();
        zoomBy(1);
        break;
      case "-":
      case "_":
        event.preventDefault();
        zoomBy(-1);
        break;
      case "Home":
        event.preventDefault();
        resetMap();
        break;
    }
  }

  function onPointerDown(event: ReactPointerEvent<HTMLDivElement>): void {
    if (event.button !== 0 || event.isPrimary === false || eventTargetIsControl(event.target)) return;
    const current = viewRef.current;
    const center = coordinateToWorldPixels(current.center, current.zoom);
    dragRef.current = {
      pointerId: event.pointerId,
      clientX: event.clientX,
      clientY: event.clientY,
      centerPixels: center,
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
    event.preventDefault();
  }

  function onPointerMove(event: ReactPointerEvent<HTMLDivElement>): void {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const currentZoom = viewRef.current.zoom;
    updateView({
      center: worldPixelsToCoordinate(
        drag.centerPixels.x - (event.clientX - drag.clientX),
        drag.centerPixels.y - (event.clientY - drag.clientY),
        currentZoom,
      ),
      zoom: currentZoom,
    });
  }

  function finishPointer(event: ReactPointerEvent<HTMLDivElement>): void {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture?.(event.pointerId);
    }
  }

  function markTileFailed(tileKey: string): void {
    setTileErrors((current) => {
      if (current.has(tileKey)) return current;
      const next = new Set(current);
      next.add(tileKey);
      return next;
    });
  }

  function retryTiles(): void {
    setTileErrors(new Set());
    setTileReload((current) => current + 1);
  }

  const categoryCounts = validPoints.reduce<Record<PreviewKind | "earthquake", number>>((counts, point) => {
    counts[point.kind] += 1;
    return counts;
  }, { hospital: 0, police: 0, fire_station: 0, flood_report: 0, earthquake: 0 });

  const mapCaption = (
    <>
      <header className="source-point-map__header">
        <div>
          <p className="source-point-map__kicker">{unified ? "OpenStreetMap · PetaBencana · USGS" : "Peta titik dari pratinjau sumber"}</p>
          <h2 id={titleId}>{unified ? "Jelajah peta sumber" : regional ? "Asal gempa regional" : "Lokasi sumber"}</h2>
        </div>
        <div className="source-point-map__header-actions">
          {onReturnToList && (
            <button className="source-point-map__button source-point-map__button--quiet" type="button" onClick={onReturnToList}>
              Kembali ke daftar
            </button>
          )}
          <span className="source-point-map__zoom-label">Zoom {view.zoom}</span>
        </div>
      </header>

      <p className="source-point-map__notice">
        {unified ? <><strong>H/P/D:</strong> fasilitas rujukan. <strong>B:</strong> laporan banjir belum ditinjau Waspada. <strong>G:</strong> asal gempa, bukan zona dampak. Rincian batas data ada di legenda.</> : regional ? <><strong>Episentrum USGS:</strong> lokasi asal gempa, bukan zona dampak. Wilayah kueri bukan batas resmi atau area bahaya; dampak di Jakarta belum ditetapkan.</> : <><strong>Fasilitas:</strong> titik rujukan; kesiapan layanan tidak diketahui. <strong>Laporan warga:</strong> belum ditinjau Waspada. <strong>Pusat cakupan OSM:</strong> perkiraan.</>}
      </p>
    </>
  );

  return (
    <section className={`source-point-map${unified ? " source-point-map--unified" : ""}`} aria-labelledby={titleId}>
      {!unified && mapCaption}
      {unified && <p className="source-point-map__source-key" role="note" aria-label="Arti dan batas titik pada peta">
        <strong>H/P/D:</strong> fasilitas, kesiapan belum diketahui. <strong>B:</strong> laporan belum ditinjau. <strong>G:</strong> asal gempa, bukan dampak. <strong>Kelompok tampilan:</strong> angka catatan; jangkar tampilan, bukan koordinat kejadian atau batas dampak.
      </p>}
      <p id={helpId} className="source-point-map__sr-only">
        Peta interaktif. Gunakan tombol perbesar dan perkecil, tombol panah saat fokus pada peta, atau seret dengan penunjuk. Tombol Home mengembalikan peta ke {resetPlace}.
      </p>
      <div
        ref={viewportRef}
        className="source-point-map__viewport"
        role="region"
        aria-label={unified ? "Peta terpadu fasilitas OpenStreetMap, laporan PetaBencana, dan episentrum USGS" : regional ? "Peta episentrum katalog USGS regional" : "Peta titik pratinjau sumber OpenStreetMap dan PetaBencana"}
        aria-describedby={helpId}
        aria-keyshortcuts="ArrowLeft ArrowRight ArrowUp ArrowDown + - Home"
        tabIndex={0}
        data-map-zoom={view.zoom}
        data-map-center={`${view.center[0]},${view.center[1]}`}
        onKeyDown={onMapKeyDown}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={finishPointer}
        onPointerCancel={finishPointer}
      >
        <div className="source-point-map__tiles" aria-hidden="true">
          {templateIsValid && tiles.map((tile) => (
            <img
              key={`${tile.key}:${tileReload}`}
              className="source-point-map__tile"
              src={createOsmTileUrl(tileTemplate, tile)}
              alt=""
              width={TILE_SIZE}
              height={TILE_SIZE}
              draggable={false}
              loading="lazy"
              decoding="async"
              referrerPolicy="strict-origin-when-cross-origin"
              data-tile-key={tile.key}
              style={{ left: tile.left, top: tile.top } satisfies CSSProperties}
              onError={() => markTileFailed(tileErrorKey(tileTemplate, tile.key))}
            />
          ))}
        </div>

        <div className="source-point-map__markers">
          {displayPositions.map(({ item, left, top }) => {
            if (item.type === "cluster") {
              const { cluster } = item;
              const label = clusterAccessibleLabel(cluster);
              const sourceText = cluster.source === "osm" ? "OSM" : cluster.source === "petabencana" ? "PB" : "USGS";
              return (
                <button
                  key={item.key}
                  className={`source-point-map__cluster source-point-map__cluster--${cluster.source}`}
                  type="button"
                  style={{ left, top } satisfies CSSProperties}
                  aria-label={label}
                  title={label}
                  data-source={cluster.source}
                  data-count={cluster.count}
                  data-cluster-id={cluster.clusterId}
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={(event) => {
                    event.stopPropagation();
                    zoomIntoCluster(cluster);
                  }}
                >
                  <span className="source-point-map__cluster-count" aria-hidden="true">{cluster.count}</span>
                  <span className="source-point-map__cluster-source" aria-hidden="true">{sourceText}</span>
                </button>
              );
            }

            const { point } = item;
            const selected = point.id === selectedId;
            const category = CATEGORY_LABELS[point.kind];
            const sourceClass = point.source;
            return (
              <button
                key={`${point.source}:${point.id}`}
                className={`source-point-map__marker source-point-map__marker--${sourceClass}${selected ? " source-point-map__marker--selected" : ""}`}
                type="button"
                style={{ left, top } satisfies CSSProperties}
                aria-label={`${pointDescription(point)} Pilih titik ini.`}
                aria-pressed={selected}
                title={pointDescription(point)}
                data-source={point.source}
                data-kind={point.kind}
                data-record-id={point.id}
                data-selected={selected ? "true" : "false"}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.stopPropagation();
                  onSelect(point.id);
                }}
              >
                <span className="source-point-map__marker-code" aria-hidden="true">{category.letter}</span>
                <span className="source-point-map__marker-category">{category.label}</span>
                <span className="source-point-map__marker-name">{point.title}</span>
              </button>
            );
          })}
        </div>

        {!templateIsValid && (
          <div className="source-point-map__tile-message source-point-map__tile-message--error" role="alert">
            <strong>Alamat peta dasar tidak valid.</strong> Peta hanya menerima template XYZ HTTPS tanpa kredensial.
          </div>
        )}

        {visibleTileErrorCount > 0 && (
          <div className="source-point-map__tile-message" role="status" aria-live="polite">
            <p>
              {visibleTileErrorCount === 1 ? "Satu ubin" : `${visibleTileErrorCount} ubin`} peta dasar gagal dimuat. Titik sumber tetap terlihat; gunakan daftar sumber untuk memeriksa rincian dan tautannya.
            </p>
            <div className="source-point-map__message-actions">
              <button className="source-point-map__button" type="button" onClick={retryTiles}>Coba muat ulang peta</button>
              {onReturnToList && <button className="source-point-map__button source-point-map__button--quiet" type="button" onClick={onReturnToList}>Kembali ke daftar sumber</button>}
            </div>
          </div>
        )}

        {validPoints.length === 0 && (
          <div className="source-point-map__empty" role="status">
            <strong>Tidak ada titik sumber untuk ditampilkan.</strong>
            <span>Hasil kosong tidak menyatakan bahwa wilayah aman.</span>
          </div>
        )}
        {validPoints.length > 0 && displayPositions.length === 0 && (
          <div className="source-point-map__empty" role="status">
            <strong>Tidak ada titik sumber pada area peta yang terlihat.</strong>
            <span>{unified ? "Pilih titik dari daftar, Jakarta awal, atau Kawasan gempa. Area peta kosong tidak menyatakan wilayah aman." : `Pilih lokasi dari daftar atau kembalikan peta ke ${resetPlace}.`}</span>
            <button className="source-point-map__button" type="button" onClick={resetMap}>Kembalikan peta ke {resetPlace}</button>
          </div>
        )}

        <div className="source-point-map__controls" role="group" aria-label="Kontrol peta">
          <button className="source-point-map__map-control" type="button" aria-label="Perbesar peta" onClick={() => zoomBy(1)}>+</button>
          <button className="source-point-map__map-control" type="button" aria-label="Perkecil peta" onClick={() => zoomBy(-1)}>−</button>
          {selectedPoint && <button className="source-point-map__map-control source-point-map__map-control--wide" type="button" onClick={centerOnSelection}>Pusatkan pilihan</button>}
          <button className="source-point-map__map-control source-point-map__map-control--wide" type="button" onClick={resetMap}>{regional ? "Regional awal" : "Jakarta awal"}</button>
          {unified && <button className="source-point-map__map-control source-point-map__map-control--wide" type="button" onClick={showQuakeRegion}>Kawasan gempa</button>}
        </div>

        <a
          className="source-point-map__attribution"
          href="https://www.openstreetmap.org/copyright"
          target="_blank"
          rel="noreferrer"
          onPointerDown={(event) => event.stopPropagation()}
        >
          © OpenStreetMap contributors
        </a>
      </div>

      {unified && <div className="source-point-map__caption">{mapCaption}</div>}
      <LegendContainer className={unified ? "source-point-map__legend-disclosure" : "source-point-map__legend-wrapper"}>
      {unified && <summary>Legenda &amp; sumber <span>H · P · D · B · G</span></summary>}
      <div className="source-point-map__legend" aria-label="Legenda kategori dan sumber">
        {!regional && <>
        <div className="source-point-map__legend-group">
          <p>Fasilitas rujukan OSM</p>
          <ul>
            {(["hospital", "police", "fire_station"] as const).map((kind) => (
              <li key={kind}>
                <span className="source-point-map__legend-code source-point-map__legend-code--osm" data-kind={kind} aria-hidden="true">{CATEGORY_LABELS[kind].letter}</span>
                <span>{CATEGORY_LABELS[kind].label}</span>
                <span className="source-point-map__legend-count">{categoryCounts[kind]}</span>
              </li>
            ))}
          </ul>
          <small>Titik referensi; ketersediaan layanan tidak ditampilkan.{unified && " Kesiapan layanan tidak diketahui. Pusat cakupan OSM adalah perkiraan, bukan pintu masuk gedung."}</small>
        </div>
        <div className="source-point-map__legend-group source-point-map__legend-group--reports">
          <p>Laporan warga PetaBencana</p>
          <ul>
            <li>
              <span className="source-point-map__legend-code source-point-map__legend-code--report" data-kind="flood_report" aria-hidden="true">B</span>
              <span>{CATEGORY_LABELS.flood_report.label}</span>
              <span className="source-point-map__legend-count">{categoryCounts.flood_report}</span>
            </li>
          </ul>
          <small>Belum ditinjau atau dipublikasikan oleh Waspada.</small>
        </div>
        </>}
        {(unified || regional || categoryCounts.earthquake > 0) && <div className="source-point-map__legend-group">
          <p>Katalog gempa USGS</p>
          <ul><li>
            <span className="source-point-map__legend-code source-point-map__legend-code--quake" data-kind="earthquake" aria-hidden="true">G</span>
            <span>Episentrum gempa</span>
            <span className="source-point-map__legend-count">{categoryCounts.earthquake}</span>
          </li></ul>
          <small>Lokasi asal gempa; dampak di Jakarta belum ditetapkan. Sumber: U.S. Geological Survey (USGS).</small>
        </div>}
      </div>
      {unified && <p className="source-point-map__legend-note">Jumlah mengikuti catatan yang dimuat dan filter daftar. Kelompok bernomor hanya untuk tampilan: jumlah bukan bukti penguat, tingkat bahaya, bahaya saat ini, atau jumlah kejadian independen; jangkar kelompok bukan koordinat kejadian atau batas dampak. Pilih kelompok untuk memperbesar peta, lalu pilih marker individual atau gunakan daftar untuk membuka catatan. Prakiraan cuaca ada di panel Cuaca; titik grid model tidak dipetakan sebagai kejadian.</p>}
      </LegendContainer>
    </section>
  );
}
