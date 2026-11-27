import type { EventView, PublicFeatureCollection, PublicGeometry, PublicGeoJSONGeometry, PublicGeoJSONPosition } from "@waspada/worker/public-contracts";
import type { ReactNode } from "react";
import { coordinateToWorldPixels, createOsmTileUrl, getVisibleMapTiles, worldPixelsToCoordinate, type MapCoordinate, type VisibleMapTile } from "./map-tiles.js";

export type MapSelection =
  | { kind: "none" }
  | { kind: "presentation" }
  | { kind: "api-event"; event: EventView; featureId?: string };

export type GeoJSONMapState =
  | { status: "idle" | "loading" | "unavailable" }
  | { status: "loaded"; data: PublicFeatureCollection };

const CRS84_ENVELOPE = {
  west: 106.32,
  south: -6.4,
  east: 106.98,
  north: -5.16,
} as const;
export const VIEW_SIZE = 500;
/** Zoom of the whole-Jakarta view. The envelope is about 454 px tall at this zoom, inside the 500 px view. */
const JAKARTA_VIEW_ZOOM = 9;
const JAKARTA_VIEW_CENTER: MapCoordinate = [
  (CRS84_ENVELOPE.west + CRS84_ENVELOPE.east) / 2,
  (CRS84_ENVELOPE.south + CRS84_ENVELOPE.north) / 2,
];

type ProjectedPosition = [x: number, y: number];

/**
 * The whole-Jakarta view (HOSTED-39). The OpenStreetMap tiles are Web Mercator, so the pins use the same projection and
 * each pin sits on the tile that covers its coordinate.
 */
export const JAKARTA_MAP_VIEW = mercatorViewAt(JAKARTA_VIEW_CENTER, JAKARTA_VIEW_ZOOM, { width: VIEW_SIZE, height: VIEW_SIZE });

export function projectCRS84Position(position: PublicGeoJSONPosition): ProjectedPosition {
  return JAKARTA_MAP_VIEW.project(position);
}

export function positionsInGeometry(geometry: PublicGeoJSONGeometry): PublicGeoJSONPosition[] {
  switch (geometry.type) {
    case "Point":
      return [geometry.coordinates];
    case "MultiPoint":
    case "LineString":
      return geometry.coordinates;
    case "MultiLineString":
    case "Polygon":
      return geometry.coordinates.flat();
    case "MultiPolygon":
      return geometry.coordinates.flat(2);
  }
}

type Projector = (position: PublicGeoJSONPosition) => ProjectedPosition;

function linePath(positions: PublicGeoJSONPosition[], close = false, project: Projector = projectCRS84Position): string {
  const path = positions.map((position, index) => {
    const [x, y] = project(position);
    return (index === 0 ? "M " : "L ") + x.toFixed(2) + " " + y.toFixed(2);
  }).join(" ");
  return close ? path + " Z" : path;
}

function polygonPath(rings: PublicGeoJSONPosition[][], project: Projector = projectCRS84Position): string {
  return rings.map((ring) => linePath(ring, true, project)).join(" ");
}

export function renderGeometry(geometry: PublicGeoJSONGeometry, project: Projector = projectCRS84Position): ReactNode {
  switch (geometry.type) {
    case "Point": {
      const [cx, cy] = project(geometry.coordinates);
      return (
        <g className="geo-feature__pin-group">
          <circle className="geo-feature__pulse" cx={cx} cy={cy} r="16" fill="none" stroke="var(--kali-teal)" strokeWidth="2" opacity="0.6" />
          <circle className="geo-feature__point" cx={cx} cy={cy} r="8" />
        </g>
      );
    }
    case "MultiPoint":
      return geometry.coordinates.map((position, index) => {
        const [cx, cy] = project(position);
        return <circle key={index} className="geo-feature__point" cx={cx} cy={cy} r="7" />;
      });
    case "LineString":
      return <path className="geo-feature__line" d={linePath(geometry.coordinates, false, project)} />;
    case "MultiLineString":
      return geometry.coordinates.map((line, index) => (
        <path key={index} className="geo-feature__line" d={linePath(line, false, project)} />
      ));
    case "Polygon":
      return <path className="geo-feature__polygon" d={polygonPath(geometry.coordinates, project)} fillRule="evenodd" />;
    case "MultiPolygon":
      return geometry.coordinates.map((polygon, index) => (
        <path key={index} className="geo-feature__polygon" d={polygonPath(polygon, project)} fillRule="evenodd" />
      ));
  }
}

export function formatCoordinates(geometry: PublicGeoJSONGeometry): string {
  return positionsInGeometry(geometry)
    .map((position) => String(position[0]) + ", " + String(position[1]))
    .join(" · ");
}

function insideMapArea(position: PublicGeoJSONPosition): boolean {
  return position[0] >= CRS84_ENVELOPE.west && position[0] <= CRS84_ENVELOPE.east &&
    position[1] >= CRS84_ENVELOPE.south && position[1] <= CRS84_ENVELOPE.north;
}

/** Record (detail) map, HOSTED-33: the same Web Mercator tiles and pixel maths as the home map (SourcePointMap). */
/** Highest zoom the record map uses. A single point is shown at this zoom. */
export const RECORD_MAP_ZOOM = 11;
/** Lowest zoom the fit may fall back to, so a spread-out record stays readable. */
export const RECORD_MAP_MIN_ZOOM = 9;
/** View size in CSS px. The canvas keeps this aspect ratio (31rem x 20rem, as before). */
export const RECORD_MAP_VIEW = { width: 496, height: 320 } as const;
/** Kept clear around the fitted bounds, so markers and line strokes are not cut at the canvas edge. */
export const RECORD_MAP_FIT_PADDING_PX = 24;
const BASEMAP_TILE_TEMPLATE = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
const BASEMAP_TILE_PX = 256;
const RECORD_MAP_ENVELOPE_CENTER: MapCoordinate = [
  (CRS84_ENVELOPE.west + CRS84_ENVELOPE.east) / 2,
  (CRS84_ENVELOPE.south + CRS84_ENVELOPE.north) / 2,
];

/** A Web Mercator view. Basemap tiles and every projected position share its zoom and origin. */
export interface MercatorView {
  zoom: number;
  width: number;
  height: number;
  /** World pixel (at `zoom`) of the view's top-left corner. */
  origin: { x: number; y: number };
  /** Base-map tiles; left/top are offsets from the view's top-left corner. */
  tiles: VisibleMapTile[];
  /** CRS84 to view pixels, at the same zoom and origin as the tiles. */
  project: Projector;
}

/** The view centred on `center` at `zoom`. Its tiles and its projector come from the same world-pixel origin. */
function mercatorViewAt(center: MapCoordinate, zoom: number, size: { width: number; height: number }): MercatorView {
  const centerPixels = coordinateToWorldPixels(center, zoom);
  const origin = { x: centerPixels.x - size.width / 2, y: centerPixels.y - size.height / 2 };
  const project: Projector = (position) => {
    const world = coordinateToWorldPixels([position[0], position[1]], zoom);
    return [world.x - origin.x, world.y - origin.y];
  };
  return {
    zoom,
    width: size.width,
    height: size.height,
    origin,
    tiles: getVisibleMapTiles(size.width, size.height, center, zoom),
    project,
  };
}

export interface RecordMapLayout extends MercatorView {
  /** Centre of the fitted bounds; the envelope centre when nothing is drawable. */
  center: MapCoordinate;
  /** The event point in view pixels. Null when the record has no point: no pin is invented. */
  pin: { x: number; y: number } | null;
}

/** What the view is fitted to: pins (Point geometries) first, every drawable position when there are no pins. */
export interface RecordMapFocus {
  points: readonly MapCoordinate[];
  positions: readonly MapCoordinate[];
}

interface PixelExtent {
  width: number;
  height: number;
  centre: { x: number; y: number };
}

/** Web Mercator extent of the positions at one zoom. Mercator is monotone, so the extremes are the extremes of the positions. */
function pixelExtent(positions: readonly MapCoordinate[], zoom: number): PixelExtent {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const position of positions) {
    const world = coordinateToWorldPixels(position, zoom);
    minX = Math.min(minX, world.x);
    maxX = Math.max(maxX, world.x);
    minY = Math.min(minY, world.y);
    maxY = Math.max(maxY, world.y);
  }
  return { width: maxX - minX, height: maxY - minY, centre: { x: (minX + maxX) / 2, y: (minY + maxY) / 2 } };
}

/** The highest zoom in [MIN, MAX] at which the positions fit inside the padded view; MIN when none does. */
function fitZoom(positions: readonly MapCoordinate[], size: { width: number; height: number }): number {
  const innerWidth = size.width - RECORD_MAP_FIT_PADDING_PX * 2;
  const innerHeight = size.height - RECORD_MAP_FIT_PADDING_PX * 2;
  for (let zoom = RECORD_MAP_ZOOM; zoom >= RECORD_MAP_MIN_ZOOM; zoom -= 1) {
    const extent = pixelExtent(positions, zoom);
    if (extent.width <= innerWidth && extent.height <= innerHeight) return zoom;
  }
  return RECORD_MAP_MIN_ZOOM;
}

function fitCentre(positions: readonly MapCoordinate[], zoom: number): MapCoordinate {
  const { centre } = pixelExtent(positions, zoom);
  return worldPixelsToCoordinate(centre.x, centre.y, zoom);
}

/**
 * Lays out the record map. The view centres on the bounds of the pins (or of every position when there are no
 * pins), at the zoom from fitZoom. Tiles sit at their Web Mercator pixel offsets, and the pin and every geometry
 * use the same zoom and origin, so they stay aligned with the basemap.
 */
export function layoutRecordMap(
  focus: RecordMapFocus,
  size: { width: number; height: number } = RECORD_MAP_VIEW,
): RecordMapLayout {
  const anchors = focus.points.length > 0 ? focus.points : focus.positions;
  const zoom = anchors.length > 0 ? fitZoom(anchors, size) : RECORD_MAP_ZOOM;
  const center = anchors.length > 0 ? fitCentre(anchors, zoom) : RECORD_MAP_ENVELOPE_CENTER;
  const view = mercatorViewAt(center, zoom, size);
  const firstPoint = focus.points[0];
  const pinPosition = firstPoint === undefined ? null : view.project([firstPoint[0], firstPoint[1]]);
  return {
    ...view,
    center,
    pin: pinPosition === null ? null : { x: pinPosition[0], y: pinPosition[1] },
  };
}

/** Point geometries are the pins; every drawable position feeds the fallback fit. Lines and polygons never give a pin. */
function recordFocusOf(drawable: readonly PublicGeometry[]): RecordMapFocus {
  const points: MapCoordinate[] = [];
  const positions: MapCoordinate[] = [];
  for (const item of drawable) {
    if (item.geometry.type === "Point") points.push([item.geometry.coordinates[0], item.geometry.coordinates[1]]);
    for (const position of positionsInGeometry(item.geometry)) positions.push([position[0], position[1]]);
  }
  return { points, positions };
}

/** Basemap tiles for a Web Mercator view. Each tile sits at its pixel offset, sized as a share of the view. */
export function BasemapTiles({ view, className, tileClassName }: { view: MercatorView; className: string; tileClassName: string }) {
  const percentX = (value: number) => (value / view.width) * 100 + "%";
  const percentY = (value: number) => (value / view.height) * 100 + "%";
  return (
    <div className={className} aria-hidden="true">
      {view.tiles.map((tile) => (
        <img
          key={tile.key}
          className={tileClassName}
          src={createOsmTileUrl(BASEMAP_TILE_TEMPLATE, tile)}
          alt=""
          width={BASEMAP_TILE_PX}
          height={BASEMAP_TILE_PX}
          draggable={false}
          decoding="async"
          referrerPolicy="strict-origin-when-cross-origin"
          style={{
            left: percentX(tile.left),
            top: percentY(tile.top),
            width: percentX(BASEMAP_TILE_PX),
            height: percentY(BASEMAP_TILE_PX),
          }}
        />
      ))}
    </div>
  );
}

/**
 * Record detail (page and #peta sheet): draws only the geometries the API returned for this record.
 * Nothing is added: no point, radius or area. A geometry outside the map area is counted, not drawn.
 * "Tidak dipetakan" appears only when the record's geometry list is empty and the record is not whole_view.
 * A whole_view record has no usable point: it says it is on the whole Jakarta view, with no pin.
 */
export function RecordMapPanel({
  title,
  geometries,
  locationDisplay,
  onReturnToList,
}: {
  title: string;
  /** undefined when the response had no geometries field (unknown); an empty array means the record has none. */
  geometries: readonly PublicGeometry[] | undefined;
  /** HOSTED-10: "whole_view" means the record has no usable point and is shown on the whole Jakarta view. */
  locationDisplay?: EventView["location_display"];
  onReturnToList: () => void;
}) {
  const drawable = (geometries ?? []).filter((item) => {
    const positions = positionsInGeometry(item.geometry);
    return positions.length > 0 && positions.every(insideMapArea);
  });
  const notDrawn = (geometries?.length ?? 0) - drawable.length;
  // Tiles are drawn only with drawable geometry; the "Tanpa peta dasar" chip stays for the no-tiles states.
  const showsBaseMap = drawable.length > 0;
  const layout = layoutRecordMap(recordFocusOf(drawable));

  return (
    <section className="map-panel" aria-labelledby="record-map-title">
      <header className="panel-heading map-panel__heading">
        <div>
          <p className="section-kicker">Lokasi dari laporan</p>
          <h2 id="record-map-title">Peta lokasi</h2>
        </div>
        {!showsBaseMap && <span className="fixture-chip">Tanpa peta dasar</span>}
      </header>

      <p className="map-panel__intro">
        Hanya lokasi dari laporan ini yang digambar. Peta tidak menambahkan titik, radius, atau area sekitar.
      </p>

      <figure className="map-figure">
        {geometries === undefined ? (
          <div className="map-unavailable" role="status">
            <span className="map-unavailable__mark" aria-hidden="true">i</span>
            <h3>Lokasi belum tersedia dalam data ini</h3>
            <p>Peta lokasi tidak dapat dibentuk dari data ini. Keadaan dan kelengkapan data tidak dapat disimpulkan dari peta.</p>
          </div>
        ) : geometries.length === 0 ? (
          <div className="map-unavailable" role="status">
            <span className="map-unavailable__mark" aria-hidden="true">—</span>
            <h3>{title}</h3>
            {locationDisplay === "whole_view" ? (
              <>
                <p>Lokasi: seluruh peta Jakarta. Laporan ini tidak punya titik di peta; daftar tetap menjadi sumber lengkap.</p>
                <p className="supporting-note">Tanpa titik di peta bukan pernyataan bahwa area aman.</p>
              </>
            ) : (
              <>
                <p>Tidak dipetakan. Laporan ini tidak menyertakan lokasi; daftar tetap tersedia sebagai alternatif lengkap.</p>
                <p className="supporting-note">Tidak adanya lokasi bukan pernyataan bahwa suatu area aman.</p>
              </>
            )}
            <button className="button button--quiet map-return" type="button" onClick={onReturnToList}>Kembali ke daftar</button>
          </div>
        ) : drawable.length === 0 ? (
          <div className="map-unavailable" role="status">
            <span className="map-unavailable__mark" aria-hidden="true">—</span>
            <h3>Lokasi di luar area peta</h3>
            <p>{`${geometries.length} lokasi dari laporan berada di luar area peta Jakarta yang ditampilkan, sehingga tidak digambar. Ini bukan pernyataan bahwa area aman.`}</p>
            <button className="button button--quiet map-return" type="button" onClick={onReturnToList}>Kembali ke daftar</button>
          </div>
        ) : (
          <>
            <div className="map-canvas map-canvas--osm record-map">
              <BasemapTiles view={layout} className="record-map__tiles" tileClassName="record-map__tile" />
              <svg
                className="geojson-map"
                viewBox={`0 0 ${layout.width} ${layout.height}`}
                role="group"
                aria-label={"Lokasi laporan " + title}
              >
                {drawable.map((item) => (
                  <g key={item.geometry_id} className="geo-feature" data-geometry-id={item.geometry_id}>
                    <title>{title + ", " + item.role.replaceAll("_", " ") + ", " + item.geometry.type}</title>
                    {renderGeometry(item.geometry, layout.project)}
                  </g>
                ))}
              </svg>
              <a
                className="record-map__attribution"
                href="https://www.openstreetmap.org/copyright"
                target="_blank"
                rel="noreferrer"
              >
                © OpenStreetMap contributors
              </a>
            </div>
            <figcaption className="map-caption">
              <strong>{`${drawable.length} lokasi pada laporan ini`}</strong>
              <span>
                {notDrawn > 0 ? `${notDrawn} lokasi di luar area peta tidak digambar. ` : ""}
                Garis, titik, dan bidang digambar apa adanya dari laporan.
              </span>
            </figcaption>
            <dl className="coordinate-row">
              <div className="coordinate-row__source">
                <dt>Koordinat dari laporan</dt>
                <dd>{drawable.map((item) => formatCoordinates(item.geometry)).join("; ")}</dd>
              </div>
              <div>
                <dt>Posisi di peta</dt>
                <dd>Posisi titik sesuai koordinat dari laporan.</dd>
              </div>
            </dl>
          </>
        )}
      </figure>

      <footer className="map-legend">
        <span className="legend-point" aria-hidden="true" />
        <span>Lokasi dari laporan ini</span>
        <span className="map-legend__note">Bentuk dan warna tidak menilai tingkat bahaya.</span>
      </footer>
    </section>
  );
}
