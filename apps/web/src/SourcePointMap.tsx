import * as React from "react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import type { PreviewKind, PreviewRecord } from "@waspada/worker/source-preview-contracts";

export type MapCoordinate = readonly [longitude: number, latitude: number];

export interface VisibleMapTile {
  key: string;
  x: number;
  y: number;
  zoom: number;
  left: number;
  top: number;
}

export interface SourcePointMapProps {
  points: readonly PreviewRecord[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onReturnToList?: () => void;
  tileTemplate?: string;
}

const TILE_SIZE = 256;
const MAX_MERCATOR_LATITUDE = 85.0511287798066;
const INITIAL_CENTER: MapCoordinate = [106.83, -6.19];
const INITIAL_ZOOM = 12;
const MIN_ZOOM = 4;
const MAX_ZOOM = 18;
const MAX_VISIBLE_TILES = 100;
const MAX_TILES_PER_AXIS = Math.floor(Math.sqrt(MAX_VISIBLE_TILES));
const DEFAULT_VIEWPORT = { width: 640, height: 400 };
const DEFAULT_TILE_TEMPLATE = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";

const CATEGORY_LABELS: Record<PreviewKind, { letter: string; label: string }> = {
  hospital: { letter: "H", label: "Rumah sakit" },
  police: { letter: "P", label: "Kepolisian" },
  fire_station: { letter: "D", label: "Pemadam kebakaran" },
  flood_report: { letter: "B", label: "Laporan banjir" },
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

function isValidRecordCoordinate(point: PreviewRecord): boolean {
  const [longitude, latitude] = point.coordinates;
  return Number.isFinite(longitude) &&
    Number.isFinite(latitude) &&
    longitude >= -180 && longitude <= 180 &&
    latitude >= -90 && latitude <= 90;
}

function selectedPointFor(points: readonly PreviewRecord[], selectedId: string | null): PreviewRecord | null {
  if (selectedId === null) return null;
  return points.find((point) => point.id === selectedId && isValidRecordCoordinate(point)) ?? null;
}

function initialMapView(points: readonly PreviewRecord[], selectedId: string | null): MapView {
  const selectedPoint = selectedPointFor(points, selectedId);
  return {
    center: selectedPoint ? [selectedPoint.coordinates[0], selectedPoint.coordinates[1]] : INITIAL_CENTER,
    zoom: INITIAL_ZOOM,
  };
}

function pointDescription(point: PreviewRecord): string {
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
}: SourcePointMapProps) {
  // Keep the React binding available to the classic JSX transform used by the Node test runner.
  void React;
  const viewportRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragStart | null>(null);
  const [view, setView] = useState<MapView>(() => initialMapView(points, selectedId));
  const viewRef = useRef(view);
  const [viewportSize, setViewportSize] = useState(DEFAULT_VIEWPORT);
  const [tileErrors, setTileErrors] = useState<ReadonlySet<string>>(() => new Set());
  const [tileReload, setTileReload] = useState(0);
  const selectedPoint = selectedPointFor(points, selectedId);
  const selectedLongitude = selectedPoint?.coordinates[0] ?? null;
  const selectedLatitude = selectedPoint?.coordinates[1] ?? null;
  const validPoints = useMemo(() => points.filter(isValidRecordCoordinate), [points]);
  const templateIsValid = useMemo(() => isValidOsmTileTemplate(tileTemplate), [tileTemplate]);
  const tiles = useMemo(
    () => getVisibleMapTiles(viewportSize.width, viewportSize.height, view.center, view.zoom),
    [view.center, view.zoom, viewportSize.height, viewportSize.width],
  );
  const centerPixels = coordinateToWorldPixels(view.center, view.zoom);
  const mapOriginX = centerPixels.x - viewportSize.width / 2;
  const mapOriginY = centerPixels.y - viewportSize.height / 2;
  const pointPositions = validPoints.flatMap((point) => {
    const pixels = coordinateToWorldPixels(point.coordinates, view.zoom);
    const left = pixels.x - mapOriginX;
    const top = pixels.y - mapOriginY;
    if (left < -36 || top < -36 || left > viewportSize.width + 36 || top > viewportSize.height + 36) return [];
    return [{ point, left, top }];
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
    if (selectedPoint && selectedLongitude !== null && selectedLatitude !== null) {
      updateView({ ...viewRef.current, center: [selectedLongitude, selectedLatitude] });
    }
  }, [selectedId, selectedLongitude, selectedLatitude]);

  function updateView(nextView: MapView): void {
    viewRef.current = nextView;
    setView(nextView);
  }

  function zoomBy(step: number): void {
    const nextZoom = clampMapZoom(viewRef.current.zoom + step);
    if (nextZoom === viewRef.current.zoom) return;
    updateView({ ...viewRef.current, zoom: nextZoom });
  }

  function centerOnSelection(): void {
    if (!selectedPoint) return;
    updateView({
      ...viewRef.current,
      center: [selectedPoint.coordinates[0], selectedPoint.coordinates[1]],
    });
  }

  function resetMap(): void {
    updateView({ center: INITIAL_CENTER, zoom: INITIAL_ZOOM });
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

  const categoryCounts = validPoints.reduce<Record<PreviewKind, number>>((counts, point) => {
    counts[point.kind] += 1;
    return counts;
  }, { hospital: 0, police: 0, fire_station: 0, flood_report: 0 });

  return (
    <section className="source-point-map" aria-labelledby="source-point-map-title">
      <header className="source-point-map__header">
        <div>
          <p className="source-point-map__kicker">Peta titik dari pratinjau sumber</p>
          <h2 id="source-point-map-title">Lokasi sumber</h2>
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
        <strong>Fasilitas:</strong> titik rujukan; kesiapan layanan tidak diketahui. <strong>Laporan warga:</strong> belum ditinjau Waspada. <strong>Pusat cakupan OSM:</strong> perkiraan.
      </p>

      <p id="source-point-map-help" className="source-point-map__sr-only">
        Peta interaktif. Gunakan tombol perbesar dan perkecil, tombol panah saat fokus pada peta, atau seret dengan penunjuk. Tombol Home mengembalikan peta ke Jakarta.
      </p>
      <div
        ref={viewportRef}
        className="source-point-map__viewport"
        role="region"
        aria-label="Peta titik pratinjau sumber OpenStreetMap dan PetaBencana"
        aria-describedby="source-point-map-help"
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
          {pointPositions.map(({ point, left, top }) => {
            const selected = point.id === selectedId;
            const category = CATEGORY_LABELS[point.kind];
            const sourceClass = point.source === "osm" ? "osm" : "petabencana";
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
                {selected && <span className="source-point-map__marker-name">{point.title}</span>}
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
        {validPoints.length > 0 && pointPositions.length === 0 && (
          <div className="source-point-map__empty" role="status">
            <strong>Tidak ada titik sumber pada area peta yang terlihat.</strong>
            <span>Pilih lokasi dari daftar atau kembalikan peta ke Jakarta.</span>
            <button className="source-point-map__button" type="button" onClick={resetMap}>Kembalikan peta ke Jakarta</button>
          </div>
        )}

        <div className="source-point-map__controls" role="group" aria-label="Kontrol peta">
          <button className="source-point-map__map-control" type="button" aria-label="Perbesar peta" onClick={() => zoomBy(1)}>+</button>
          <button className="source-point-map__map-control" type="button" aria-label="Perkecil peta" onClick={() => zoomBy(-1)}>−</button>
          {selectedPoint && <button className="source-point-map__map-control source-point-map__map-control--wide" type="button" onClick={centerOnSelection}>Pusatkan pilihan</button>}
          <button className="source-point-map__map-control source-point-map__map-control--wide" type="button" onClick={resetMap}>Jakarta awal</button>
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

      <div className="source-point-map__legend" aria-label="Legenda kategori dan sumber">
        <div className="source-point-map__legend-group">
          <p>Fasilitas rujukan OSM</p>
          <ul>
            {(["hospital", "police", "fire_station"] as const).map((kind) => (
              <li key={kind}>
                <span className="source-point-map__legend-code source-point-map__legend-code--osm" aria-hidden="true">{CATEGORY_LABELS[kind].letter}</span>
                <span>{CATEGORY_LABELS[kind].label}</span>
                <span className="source-point-map__legend-count">{categoryCounts[kind]}</span>
              </li>
            ))}
          </ul>
          <small>Titik referensi; ketersediaan layanan tidak ditampilkan.</small>
        </div>
        <div className="source-point-map__legend-group source-point-map__legend-group--reports">
          <p>Laporan warga PetaBencana</p>
          <ul>
            <li>
              <span className="source-point-map__legend-code source-point-map__legend-code--report" aria-hidden="true">B</span>
              <span>{CATEGORY_LABELS.flood_report.label}</span>
              <span className="source-point-map__legend-count">{categoryCounts.flood_report}</span>
            </li>
          </ul>
          <small>Belum ditinjau atau dipublikasikan oleh Waspada.</small>
        </div>
      </div>
    </section>
  );
}
