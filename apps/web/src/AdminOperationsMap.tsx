import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { KeyboardEvent, PointerEvent, ReactNode } from "react";
import type { PublicGeoJSONGeometry, PublicGeoJSONPosition } from "@waspada/worker/public-contracts";
import type { AdminItem, AdminItemState, AdminLayer, AdminMapProps, AdminMode } from "./admin-types.js";
import { categoryLabel } from "./display.js";

export interface AdminMapBounds { west: number; south: number; east: number; north: number }
export interface AdminMapSize { width: number; height: number; textScale?: number }

// Query limits validate incoming positions only. They are never drawn as a boundary.
const QUERY_LIMITS: AdminMapBounds = { west: 106.32, south: -6.4, east: 106.98, north: -5.16 };
export const ADMIN_MAP_DEFAULT_VIEW: Readonly<AdminMapBounds> = Object.freeze({
  west: 106.65, south: -6.4, east: 106.98, north: -6,
});
const LONGITUDE_FACTOR = Math.cos(-6.2 * Math.PI / 180);
const INITIAL_SIZE: AdminMapSize = { width: 760, height: 520 };
const MIN_SPAN = 0.008;
const MAX_SPAN = 2.4;
const LAYERS: readonly AdminLayer[] = ["L1", "L2", "L3", "L4", "L5"];
const LAYER_LABELS: Record<AdminLayer, string> = {
  L1: "Persiapan", L2: "Grounding", L3: "Investigasi", L4: "Tinjau / terbit", L5: "Pemantauan",
};
const STATE_LABELS: Record<AdminItemState, string> = {
  queued: "Menunggu", running: "Diproses", held: "Ditahan", failed: "Gagal", done: "Selesai diproses",
};
const DATASET_LABELS: Record<AdminItem["datasetKind"], string> = { live: "Live", historical: "Historis", synthetic: "Sintetis" };

function isPosition(value: unknown): value is PublicGeoJSONPosition {
  if (!Array.isArray(value) || value.length !== 2) return false;
  const [longitude, latitude] = value;
  return typeof longitude === "number" && typeof latitude === "number" &&
    Number.isFinite(longitude) && Number.isFinite(latitude) &&
    longitude >= QUERY_LIMITS.west && longitude <= QUERY_LIMITS.east &&
    latitude >= QUERY_LIMITS.south && latitude <= QUERY_LIMITS.north;
}

function isLine(value: unknown, ring = false): boolean {
  if (!Array.isArray(value) || value.length < (ring ? 4 : 2) || !value.every(isPosition)) return false;
  return !ring || (value[0][0] === value[value.length - 1][0] && value[0][1] === value[value.length - 1][1]);
}

function isPolygon(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0 && value.every((ring) => isLine(ring, true));
}

export function isRenderableAdminGeometry(value: unknown): value is PublicGeoJSONGeometry {
  if (value === null || typeof value !== "object") return false;
  const geometry = value as { type?: unknown; coordinates?: unknown };
  const coordinates = geometry.coordinates;
  switch (geometry.type) {
    case "Point": return isPosition(coordinates);
    case "MultiPoint": return Array.isArray(coordinates) && coordinates.length > 0 && coordinates.every(isPosition);
    case "LineString": return isLine(coordinates);
    case "MultiLineString": return Array.isArray(coordinates) && coordinates.length > 0 && coordinates.every((line) => isLine(line));
    case "Polygon": return isPolygon(coordinates);
    case "MultiPolygon": return Array.isArray(coordinates) && coordinates.length > 0 && coordinates.every(isPolygon);
    default: return false;
  }
}

export function adminGeometryPositions(geometry: PublicGeoJSONGeometry): PublicGeoJSONPosition[] {
  switch (geometry.type) {
    case "Point": return [geometry.coordinates];
    case "MultiPoint":
    case "LineString": return [...geometry.coordinates];
    case "MultiLineString":
    case "Polygon": return geometry.coordinates.flat();
    case "MultiPolygon": return geometry.coordinates.flat(2);
  }
}

export function adminGeometryBounds(geometries: readonly PublicGeoJSONGeometry[]): AdminMapBounds | null {
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  for (const geometry of geometries) {
    for (const [longitude, latitude] of adminGeometryPositions(geometry)) {
      west = Math.min(west, longitude);
      south = Math.min(south, latitude);
      east = Math.max(east, longitude);
      north = Math.max(north, latitude);
    }
  }
  return Number.isFinite(west) ? { west, south, east, north } : null;
}

// Preserve every geometry for an event, or fail closed for the entire event.
export function adminItemGeometries(item: AdminItem, mode: AdminMode): PublicGeoJSONGeometry[] {
  if (mode === "simulation") {
    if (item.geometryBasis !== "synthetic_example" || item.datasetKind !== "synthetic") return [];
  } else if (item.geometryBasis !== "source_supported" ||
    !item.publicEventId || !Number.isInteger(item.eventVersion) || (item.eventVersion ?? 0) < 1) return [];
  if (item.additionalGeometries !== undefined && !Array.isArray(item.additionalGeometries)) return [];
  const geometries = [item.geometry, ...(item.additionalGeometries ?? [])].filter((geometry) => geometry !== null);
  return geometries.length > 0 && geometries.every(isRenderableAdminGeometry) ? geometries : [];
}

export function fitAdminMapBounds(bounds: AdminMapBounds): AdminMapBounds {
  const longitude = (bounds.west + bounds.east) / 2;
  const latitude = (bounds.south + bounds.north) / 2;
  // This padding changes the camera only; source geometry is never buffered.
  const width = Math.max(bounds.east - bounds.west, 0.06) * 1.24;
  const height = Math.max(bounds.north - bounds.south, 0.06) * 1.24;
  return { west: longitude - width / 2, east: longitude + width / 2, south: latitude - height / 2, north: latitude + height / 2 };
}

export function createAdminMapProjection(view: Readonly<AdminMapBounds>, size: AdminMapSize) {
  const textScale = size.textScale ?? 1;
  const left = Math.min(64 * textScale, size.width - 56);
  const right = Math.min(24 * textScale, size.width - left - 32);
  const top = 40 * textScale;
  const plot = { left, top, width: Math.max(32, size.width - left - right), height: Math.max(32, size.height - top * 2) };
  const longitude = (view.west + view.east) / 2;
  const latitude = (view.south + view.north) / 2;
  const scale = Math.min(plot.width / ((view.east - view.west) * LONGITUDE_FACTOR), plot.height / (view.north - view.south));
  const centerX = plot.left + plot.width / 2;
  const centerY = plot.top + plot.height / 2;
  const project = ([lng, lat]: PublicGeoJSONPosition): [number, number] => [centerX + (lng - longitude) * LONGITUDE_FACTOR * scale, centerY - (lat - latitude) * scale];
  const unproject = (x: number, y: number): PublicGeoJSONPosition => [longitude + (x - centerX) / (LONGITUDE_FACTOR * scale), latitude - (y - centerY) / scale];
  const [west, north] = unproject(plot.left, plot.top);
  const [east, south] = unproject(plot.left + plot.width, plot.top + plot.height);
  return { project, unproject, scale, plot, visibleBounds: { west, south, east, north } };
}

export function zoomAdminMapView(view: AdminMapBounds, factor: number): AdminMapBounds {
  const current = view.north - view.south;
  const height = Math.max(MIN_SPAN, Math.min(MAX_SPAN, current / factor));
  const width = (view.east - view.west) * height / current;
  const longitude = (view.west + view.east) / 2;
  const latitude = (view.south + view.north) / 2;
  return { west: longitude - width / 2, east: longitude + width / 2, south: latitude - height / 2, north: latitude + height / 2 };
}

export function panAdminMapView(view: AdminMapBounds, longitude: number, latitude: number): AdminMapBounds {
  return { west: view.west + longitude, east: view.east + longitude, south: view.south + latitude, north: view.north + latitude };
}

function overlaps(a: AdminMapBounds, b: AdminMapBounds): boolean {
  const epsilon = 1e-10;
  return a.west <= b.east + epsilon && a.east >= b.west - epsilon && a.south <= b.north + epsilon && a.north >= b.south - epsilon;
}

function contains(a: AdminMapBounds, b: AdminMapBounds): boolean {
  const epsilon = 1e-10;
  return a.west <= b.west + epsilon && a.east >= b.east - epsilon && a.south <= b.south + epsilon && a.north >= b.north - epsilon;
}

function gridTicks(minimum: number, maximum: number, target: number): number[] {
  const rough = (maximum - minimum) / target;
  const power = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 5, 10].map((value) => value * power).find((value) => value >= rough) ?? power * 10;
  const ticks: number[] = [];
  for (let value = Math.ceil(minimum / step) * step; value <= maximum + step * 0.001 && ticks.length < 16; value += step) {
    ticks.push(Number(value.toFixed(8)));
  }
  return ticks;
}

function coordinate(value: number, axis: "longitude" | "latitude"): string {
  return Math.abs(value).toFixed(3) + "° " + (axis === "longitude" ? (value < 0 ? "BB" : "BT") : (value < 0 ? "LS" : "LU"));
}

function StageGlyph({ layer }: { layer: AdminLayer }) {
  switch (layer) {
    case "L1": return <><path d="M-7 1v6H7V1M0-8V2m-4-4 4 4 4-4" /></>;
    case "L2": return <><circle cx="-2" cy="-2" r="5" /><path d="m2 2 6 6M-5-2h6" /></>;
    case "L3": return <><path d="M-6-6v12h12M-6 0h6v-6" /><circle cx="-6" cy="-6" r="2" /><circle cx="0" cy="-6" r="2" /><circle cx="6" cy="6" r="2" /></>;
    case "L4": return <><path d="m0-9 9 9-9 9-9-9ZM-4 0l3 3 5-6" /></>;
    case "L5": return <><path d="M-9 0q9-12 18 0Q0 12-9 0Z" /><circle r="3" /></>;
  }
}

function StateGlyph({ state }: { state: AdminItemState }) {
  switch (state) {
    case "queued": return <circle r="3.5" fill="none" />;
    case "running": return <><circle r="3.5" fill="none" strokeDasharray="4 2" /><circle r="1" /></>;
    case "held": return <path d="M-2-4v8M2-4v8" />;
    case "failed": return <path d="m-3-3 6 6M3-3l-6 6" />;
    case "done": return <path d="m-4 0 3 3 5-6" />;
  }
}

function GlyphIcon({ layer, state }: { layer?: AdminLayer; state?: AdminItemState }) {
  return <svg className="admin-map__legend-icon" viewBox="-12 -12 24 24" aria-hidden="true">{layer ? <StageGlyph layer={layer} /> : state ? <StateGlyph state={state} /> : null}</svg>;
}

function pathFor(positions: PublicGeoJSONPosition[], project: (position: PublicGeoJSONPosition) => [number, number], close = false): string {
  const path = positions.map((position, index) => {
    const [x, y] = project(position);
    return `${index === 0 ? "M" : "L"}${x.toFixed(4)},${y.toFixed(4)}`;
  }).join(" ");
  return close ? path + " Z" : path;
}

function Geometry({ geometry, project }: { geometry: PublicGeoJSONGeometry; project: (position: PublicGeoJSONPosition) => [number, number] }): ReactNode {
  const point = (position: PublicGeoJSONPosition, key: number) => {
    const [x, y] = project(position);
    return <g key={key} data-geometry="Point" data-source-coordinate={position.join(",")}><circle className="admin-map__point-hit" cx={x} cy={y} r="22" /><path className="admin-map__point-cross" d={`M${x - 7},${y}h14M${x},${y - 7}v14`} /><circle className="admin-map__source-point" cx={x} cy={y} r="4" /></g>;
  };
  const line = (positions: PublicGeoJSONPosition[], key: number) => <g key={key} data-geometry="LineString"><path className="admin-map__line-hit" d={pathFor(positions, project)} /><path className="admin-map__source-line" d={pathFor(positions, project)} /></g>;
  const polygon = (rings: PublicGeoJSONPosition[][], key: number) => <path key={key} data-geometry="Polygon" className="admin-map__source-polygon" d={rings.map((ring) => pathFor(ring, project, true)).join(" ")} fillRule="evenodd" />;
  switch (geometry.type) {
    case "Point": return point(geometry.coordinates, 0);
    case "MultiPoint": return geometry.coordinates.map(point);
    case "LineString": return line(geometry.coordinates, 0);
    case "MultiLineString": return geometry.coordinates.map(line);
    case "Polygon": return polygon(geometry.coordinates, 0);
    case "MultiPolygon": return geometry.coordinates.map(polygon);
  }
}

interface MappedItem { item: AdminItem; geometries: PublicGeoJSONGeometry[]; bounds: AdminMapBounds }

function ItemGeometry({ mapped, selected, mode, project, plot, onSelect }: {
  mapped: MappedItem; selected: boolean; project: (position: PublicGeoJSONPosition) => [number, number];
  mode: AdminMode; plot: { left: number; top: number; width: number; height: number }; onSelect: (id: string) => void;
}) {
  const { item, geometries } = mapped;
  const positions = geometries.flatMap(adminGeometryPositions);
  const onCanvas = (position: PublicGeoJSONPosition) => {
    const [px, py] = project(position);
    return px >= plot.left && px <= plot.left + plot.width && py >= plot.top && py <= plot.top + plot.height;
  };
  const anchor = positions.find(onCanvas) ?? positions[0]!;
  const [x, y] = project(anchor);
  // Annotation cards are screen-sized UI; their anchor remains an exact source vertex.
  const cardWidth = mode === "simulation" ? 70 : 86;
  const labelX = Math.max(plot.left + 4, Math.min(plot.left + plot.width - cardWidth - 8, x + 18));
  const labelY = Math.max(plot.top + 4, Math.min(plot.top + plot.height - 52, y - 54));
  const provenance = item.geometryBasis === "synthetic_example" ? "geometri contoh sintetis" : "geometri didukung sumber";
  const operation = mode === "simulation" ? `tahap ${item.layer} ${LAYER_LABELS[item.layer]}; status pemrosesan ${STATE_LABELS[item.state]}` : "proyeksi event publik; record tersedia";
  const label = `${item.title}; kategori ${categoryLabel(item.category)}; ${operation}; ${provenance}; dataset ${DATASET_LABELS[item.datasetKind]}${mode === "public_api" ? " API" : ""}`;
  return <g
    role="button" tabIndex={0} aria-label={label} aria-pressed={selected}
    className={"admin-map__feature" + (selected ? " admin-map__feature--selected" : "")}
    data-admin-map-item={item.id} data-geometry-basis={item.geometryBasis}
    onClick={() => onSelect(item.id)}
    onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onSelect(item.id); } }}
  >
    <title>{label}</title>
    {geometries.map((geometry, index) => <Geometry key={index} geometry={geometry} project={project} />)}
    {onCanvas(anchor) && <path className="admin-map__annotation-stem" d={`M${x} ${y}L${labelX + 8} ${labelY + 36}`} />}
    <g className="admin-map__annotation" transform={`translate(${labelX} ${labelY})`}>
      <rect className="admin-map__annotation-card" width={cardWidth} height="44" rx="8" />
      <g className="admin-map__stage-glyph" transform="translate(15 22)"><StageGlyph layer={mode === "simulation" ? item.layer : "L4"} /></g>
      <text className="admin-map__layer-text" x="32" y="26">{mode === "simulation" ? item.layer : "PUB"}</text>
      {mode === "simulation" && <g className="admin-map__state-glyph" transform="translate(62 37)"><circle className="admin-map__state-disc" r="8" /><StateGlyph state={item.state} /></g>}
      <rect className="admin-map__focus-ring" x="-3" y="-3" width={cardWidth + 6} height="50" rx="10" />
    </g>
  </g>;
}

export function AdminOperationsMap({ items, selectedId, onSelect, mode }: AdminMapProps) {
  const id = useId();
  const canvasRef = useRef<SVGSVGElement>(null);
  const [size, setSize] = useState(INITIAL_SIZE);
  const [view, setView] = useState<AdminMapBounds>({ ...ADMIN_MAP_DEFAULT_VIEW });
  const [announcement, setAnnouncement] = useState("");
  const drag = useRef<{ pointerId: number; x: number; y: number; view: AdminMapBounds; scale: number } | null>(null);
  const mapped = useMemo(() => items.flatMap((item): MappedItem[] => {
    const geometries = adminItemGeometries(item, mode);
    const bounds = adminGeometryBounds(geometries);
    return bounds ? [{ item, geometries, bounds }] : [];
  }), [items, mode]);
  const selected = items.find((item) => item.id === selectedId) ?? null;
  const selectedMapped = mapped.find(({ item }) => item.id === selectedId) ?? null;
  const allBounds = useMemo(() => adminGeometryBounds(mapped.flatMap(({ geometries }) => geometries)), [mapped]);
  const projection = useMemo(() => createAdminMapProjection(view, size), [view, size]);
  const textScale = size.textScale ?? 1;
  const visible = mapped.filter(({ bounds }) => overlaps(bounds, projection.visibleBounds));
  const latitudeTicks = gridTicks(projection.visibleBounds.south, projection.visibleBounds.north, Math.max(2, Math.floor(projection.plot.height / 100)));
  const longitudeTicks = gridTicks(projection.visibleBounds.west, projection.visibleBounds.east, Math.max(2, Math.floor(projection.plot.width / 140)));
  const unlocated = items.length - mapped.length;
  const zoom = (ADMIN_MAP_DEFAULT_VIEW.north - ADMIN_MAP_DEFAULT_VIEW.south) / (view.north - view.south);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const measure = () => {
      const rect = canvas.getBoundingClientRect();
      const scale = parseFloat(getComputedStyle(document.documentElement).fontSize) / 16;
      if (rect.width > 0 && rect.height > 0) setSize((current) => current.width === rect.width && current.height === rect.height && current.textScale === scale
        ? current : { width: rect.width, height: rect.height, textScale: scale });
    };
    measure();
    if (typeof ResizeObserver !== "undefined") {
      const observer = new ResizeObserver(measure);
      observer.observe(canvas);
      observer.observe(document.documentElement);
      return () => observer.disconnect();
    }
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);

  useEffect(() => { setView({ ...ADMIN_MAP_DEFAULT_VIEW }); setAnnouncement(""); drag.current = null; }, [mode]);
  useEffect(() => {
    if (!selectedMapped) return;
    setView((current) => contains(createAdminMapProjection(current, size).visibleBounds, selectedMapped.bounds)
      ? current : fitAdminMapBounds(selectedMapped.bounds));
  }, [selectedMapped, size]);

  const changeZoom = (factor: number) => {
    setView((current) => zoomAdminMapView(current, factor));
    setAnnouncement(factor > 1 ? "Tampilan diperbesar." : "Tampilan diperkecil.");
  };
  const pan = (horizontal: number, vertical: number) => {
    const width = projection.visibleBounds.east - projection.visibleBounds.west;
    const height = projection.visibleBounds.north - projection.visibleBounds.south;
    setView((current) => panAdminMapView(current, horizontal * width * 0.22, vertical * height * 0.22));
    setAnnouncement("Tampilan digeser. Koordinat tampilan diperbarui.");
  };
  const reset = () => { setView({ ...ADMIN_MAP_DEFAULT_VIEW }); setAnnouncement("Tampilan awal dipulihkan."); };
  const fitAll = () => { if (allBounds) { setView(fitAdminMapBounds(allBounds)); setAnnouncement("Semua geometri pada subset dimuat masuk tampilan, termasuk titik di luar tampilan awal."); } };
  const fitSelection = () => { if (selectedMapped) { setView(fitAdminMapBounds(selectedMapped.bounds)); setAnnouncement("Geometri record pilihan masuk tampilan."); } };
  const handleKeys = (event: KeyboardEvent<SVGSVGElement>) => {
    if (event.target !== event.currentTarget || event.ctrlKey || event.metaKey || event.altKey) return;
    const actions: Record<string, () => void> = { ArrowLeft: () => pan(-1, 0), ArrowRight: () => pan(1, 0), ArrowUp: () => pan(0, 1), ArrowDown: () => pan(0, -1), "+": () => changeZoom(1.5), "=": () => changeZoom(1.5), "-": () => changeZoom(1 / 1.5), "0": reset, f: fitAll, F: fitAll };
    const action = actions[event.key];
    if (action) { event.preventDefault(); action(); }
  };
  const pointerDown = (event: PointerEvent<SVGSVGElement>) => {
    if (event.button !== 0 || !event.isPrimary || (event.target as Element).closest("[data-admin-map-item]")) return;
    drag.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, view, scale: projection.scale };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const pointerMove = (event: PointerEvent<SVGSVGElement>) => {
    const start = drag.current;
    if (!start || start.pointerId !== event.pointerId) return;
    setView(panAdminMapView(start.view, -(event.clientX - start.x) / (start.scale * LONGITUDE_FACTOR), (event.clientY - start.y) / start.scale));
  };
  const pointerEnd = () => { drag.current = null; };

  return <section className="admin-map" aria-labelledby={`${id}-heading`}>
    <header className="admin-map__heading">
      <div><p className="admin-map__eyebrow">Ruang koordinat · CRS84</p><h2 id={`${id}-heading`}>Jejak geografis</h2></div>
      <span className={"admin-map__provenance" + (mode === "simulation" ? " admin-map__provenance--simulation" : "")}>{mode === "simulation" ? "Geometri fiktif" : "Geometri respons API"}</span>
    </header>
    <p className="admin-map__intro">{mode === "simulation" ? "Titik, segmen, dan bidang contoh sintetis untuk membaca alur operasi." : "Hanya geometri didukung sumber yang cocok dengan record publik dimuat."} Tanpa peta dasar; grid menunjukkan koordinat, bukan batas wilayah.</p>
    {mode === "public_api" && items.some((item) => item.datasetKind === "synthetic") && <p className="admin-map__dataset-note">Subset API memuat record sintetis; bukan peringatan langsung. Jenis dataset ditampilkan pada record pilihan.</p>}
    <div className="admin-map__scope">
      <p><strong>{mapped.length}</strong> record dipetakan <span aria-hidden="true">/</span> <strong>{items.length}</strong> pada subset ini</p>
      <span>{unlocated} tidak dipetakan · tetap di antrean</span>
    </div>
    <div className="admin-map__view-actions" role="group" aria-label="Cakupan tampilan koordinat">
      <button type="button" onClick={fitAll} disabled={!allBounds}>Muat di bingkai <span aria-hidden="true">↗</span></button>
      <button type="button" onClick={fitSelection} disabled={!selectedMapped}>Fokus pilihan <span aria-hidden="true">⊙</span></button>
      <button type="button" onClick={reset}>Tampilan awal <span aria-hidden="true">↺</span></button>
    </div>
    <figure className="admin-map__figure">
      <div className="admin-map__canvas-wrap">
        <svg ref={canvasRef} className="admin-map__canvas" viewBox={`0 0 ${size.width} ${size.height}`} role="group" tabIndex={0}
          aria-label="Kanvas koordinat geografis; pilih geometri untuk membuka record di pemeriksa" aria-describedby={`${id}-keyboard ${id}-limit`}
          onKeyDown={handleKeys} onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerEnd} onPointerCancel={pointerEnd} onLostPointerCapture={pointerEnd}>
          <defs><clipPath id={`${id}-clip`}><rect x={projection.plot.left} y={projection.plot.top} width={projection.plot.width} height={projection.plot.height} /></clipPath></defs>
          <g aria-hidden="true" className="admin-map__grid">
            {longitudeTicks.map((longitude) => {
              const [x] = projection.project([longitude, 0]);
              return <g key={longitude}><path d={`M${x} ${projection.plot.top}v${projection.plot.height}`} /><text x={x} y={projection.plot.top - 16 * textScale} textAnchor="middle">{longitude.toFixed(2)}°</text><path className="admin-map__grid-tick" d={`M${x} ${projection.plot.top - 5}v5M${x} ${projection.plot.top + projection.plot.height}v5`} /></g>;
            })}
            {latitudeTicks.map((latitude) => {
              const [, y] = projection.project([0, latitude]);
              return <g key={latitude}><path d={`M${projection.plot.left} ${y}h${projection.plot.width}`} /><text x={projection.plot.left - 12 * textScale} y={y + 4 * textScale} textAnchor="end">{latitude.toFixed(2)}°</text><path className="admin-map__grid-tick" d={`M${projection.plot.left - 5} ${y}h5M${projection.plot.left + projection.plot.width} ${y}h5`} /></g>;
            })}
            <g className="admin-map__north" transform={`translate(${size.width - 16 * textScale} ${18 * textScale})`}><path d="M0 10V-4m-4 5 4-5 4 5" /><text x="0" y="-8" textAnchor="middle">U</text></g>
          </g>
          <g clipPath={`url(#${id}-clip)`}>
            {visible.filter(({ item }) => item.id !== selectedId).map((mappedItem) => <ItemGeometry key={mappedItem.item.id} mapped={mappedItem} selected={false} mode={mode} project={projection.project} plot={projection.plot} onSelect={onSelect} />)}
            {visible.filter(({ item }) => item.id === selectedId).map((mappedItem) => <ItemGeometry key={mappedItem.item.id} mapped={mappedItem} selected mode={mode} project={projection.project} plot={projection.plot} onSelect={onSelect} />)}
          </g>
        </svg>
        {mapped.length === 0 && <div className="admin-map__empty" role="status"><span className="admin-map__empty-mark" aria-hidden="true">⌖</span><h3>{items.length === 0 ? "Belum ada record pada subset ini" : "Geometri belum tersedia"}</h3><p>{items.length === 0 ? "Hasil mengikuti mode dan filter saat ini." : "Record tetap dapat dipilih dari antrean. Koordinat tidak ditebak."}</p><span>Hasil kosong bukan pernyataan bahwa area aman.</span></div>}
        {mapped.length > 0 && visible.length === 0 && <div className="admin-map__empty" role="status"><span className="admin-map__empty-mark" aria-hidden="true">↗</span><h3>Geometri di luar tampilan</h3><p>Gunakan “Muat di bingkai” untuk melihat seluruh geometri pada subset ini.</p></div>}
      </div>
      <figcaption className="admin-map__extent"><span><strong>Bujur</strong> {coordinate(projection.visibleBounds.west, "longitude")} – {coordinate(projection.visibleBounds.east, "longitude")}</span><span><strong>Lintang</strong> {coordinate(projection.visibleBounds.south, "latitude")} – {coordinate(projection.visibleBounds.north, "latitude")}</span></figcaption>
    </figure>
    <div className="admin-map__navigation">
      <div className="admin-map__zoom" role="group" aria-label="Perbesaran koordinat"><button type="button" aria-label="Perkecil koordinat" onClick={() => changeZoom(1 / 1.5)} disabled={view.north - view.south >= MAX_SPAN - 0.00001}>−</button><output aria-label="Perbesaran tampilan">{zoom.toFixed(1)}×</output><button type="button" aria-label="Perbesar koordinat" onClick={() => changeZoom(1.5)} disabled={view.north - view.south <= MIN_SPAN + 0.00001}>+</button></div>
      <div className="admin-map__pan" role="group" aria-label="Geser tampilan"><button type="button" aria-label="Geser ke barat" onClick={() => pan(-1, 0)}>←</button><button type="button" aria-label="Geser ke utara" onClick={() => pan(0, 1)}>↑</button><button type="button" aria-label="Geser ke selatan" onClick={() => pan(0, -1)}>↓</button><button type="button" aria-label="Geser ke timur" onClick={() => pan(1, 0)}>→</button></div>
      <span className="admin-map__in-frame">{visible.length} dalam bingkai · {mapped.length - visible.length} di luar</span>
    </div>
    <p id={`${id}-keyboard`} className="admin-map__keyboard">Fokus kanvas: panah untuk geser, + / − untuk zoom, 0 untuk awal, F untuk muat semua. Enter / Spasi memilih geometri. Kanvas dapat diseret.</p>
    <div className="admin-map__selection" role="status" aria-live="polite">
      <span className="admin-map__selection-kicker">{selected ? "Record pilihan" : "Belum ada pilihan"}</span>
      {selected ? <><strong>{selected.title}</strong><span>{categoryLabel(selected.category)} · {mode === "simulation" ? `Tahap ${selected.layer} · Pemrosesan: ${STATE_LABELS[selected.state]}` : "Proyeksi event publik · Record tersedia"}</span><span>{selectedMapped ? `${selectedMapped.geometries.length} geometri · ${selected.geometryBasis === "synthetic_example" ? "Contoh sintetis" : "Didukung sumber"}` : "Tidak dipetakan — geometri yang sesuai mode belum tersedia."}</span><span>Dataset record: {DATASET_LABELS[selected.datasetKind]}{mode === "public_api" ? " API" : ""}{selected.datasetKind === "synthetic" ? " · bukan peringatan langsung" : ""}</span>{selected.geometryNote && <span>{selected.geometryNote}</span>}</> : <p>Pilih geometri atau record di antrean untuk membaca bukti dan alurnya.</p>}
    </div>
    <details className="admin-map__legend" open>
      <summary>Petunjuk simbol <span aria-hidden="true">＋</span></summary>
      <div className="admin-map__legend-content">
        {mode === "simulation" ? <><p className="admin-map__legend-label">Tahap operasi</p><ul className="admin-map__layer-legend">{LAYERS.map((layer) => <li key={layer}><GlyphIcon layer={layer} /><span><strong>{layer}</strong> {LAYER_LABELS[layer]}</span></li>)}</ul><p className="admin-map__legend-label">Status pemrosesan</p><ul className="admin-map__state-legend">{(Object.keys(STATE_LABELS) as AdminItemState[]).map((state) => <li key={state}><GlyphIcon state={state} /><span>{STATE_LABELS[state]}</span></li>)}</ul></> : <><ul className="admin-map__layer-legend"><li><GlyphIcon layer="L4" /><span><strong>PUB</strong> Proyeksi event publik</span></li></ul><p className="admin-map__public-limit">“Record tersedia” berarti record dikembalikan API. Tahap internal dan status pemrosesan tidak tersedia dari endpoint publik.</p></>}
        <div className="admin-map__geometry-legend"><span><i className="admin-map__key-point" aria-hidden="true" />Titik</span><span><i className="admin-map__key-line" aria-hidden="true" />Segmen</span><span><i className="admin-map__key-polygon" aria-hidden="true" />{mode === "simulation" ? "Bidang sintetis" : "Bidang respons"}</span></div>
        <p id={`${id}-limit`}>{mode === "simulation" ? "Simbol menunjukkan tahap dan status pemrosesan contoh. " : "Simbol PUB menunjukkan proyeksi event publik. "}Warna dan ukuran penanda tidak menilai bahaya atau membuat radius. Bentuk mengikuti koordinat data. Cakupan mengikuti subset dimuat, bukan seluruh Jakarta.</p>
      </div>
    </details>
    <span className="admin-map__sr-only" role="status" aria-live="polite">{announcement}</span>
  </section>;
}
