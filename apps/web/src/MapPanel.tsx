import type { EventView, PublicContext, PublicFeature, PublicFeatureCollection, PublicGeometry, PublicGeoJSONGeometry, PublicGeoJSONPosition } from "@waspada/worker/public-contracts";
import type { ReactNode } from "react";
import type { FeedStatus } from "./EventFeed.js";
import { documentedPresentationFixture as fixture } from "./presentation-fixture.js";

export type MapSelection =
  | { kind: "none" }
  | { kind: "presentation" }
  | { kind: "api-event"; event: EventView; featureId?: string };

export type GeoJSONMapState =
  | { status: "idle" | "loading" | "unavailable" }
  | { status: "loaded"; data: PublicFeatureCollection };

interface MapPanelProps {
  selection: MapSelection;
  mapState?: GeoJSONMapState;
  context?: PublicContext | null;
  feedStatus?: FeedStatus;
  visibleEvents?: EventView[];
  onSelectApiEvent?: (event: EventView, featureId: string) => void;
  onRetryMap?: () => void;
  onReturnToList: () => void;
}

const CRS84_ENVELOPE = {
  west: 106.32,
  south: -6.4,
  east: 106.98,
  north: -5.16,
} as const;
const VIEW_SIZE = 500;
const MAP_PADDING = 32;
const REFERENCE_LATITUDE = (CRS84_ENVELOPE.south + CRS84_ENVELOPE.north) / 2;
const LONGITUDE_SCALE = Math.cos((REFERENCE_LATITUDE * Math.PI) / 180);
const PROJECTED_WIDTH = (CRS84_ENVELOPE.east - CRS84_ENVELOPE.west) * LONGITUDE_SCALE;
const PROJECTED_HEIGHT = CRS84_ENVELOPE.north - CRS84_ENVELOPE.south;
const MAP_SCALE = Math.min(
  (VIEW_SIZE - MAP_PADDING * 2) / PROJECTED_WIDTH,
  (VIEW_SIZE - MAP_PADDING * 2) / PROJECTED_HEIGHT,
);
const MAP_LEFT = (VIEW_SIZE - PROJECTED_WIDTH * MAP_SCALE) / 2;
const MAP_TOP = (VIEW_SIZE - PROJECTED_HEIGHT * MAP_SCALE) / 2;

type ProjectedPosition = [x: number, y: number];
export function projectCRS84Position(position: PublicGeoJSONPosition): ProjectedPosition {
  const x = MAP_LEFT + (position[0] - CRS84_ENVELOPE.west) * LONGITUDE_SCALE * MAP_SCALE;
  const y = MAP_TOP + (CRS84_ENVELOPE.north - position[1]) * MAP_SCALE;
  return [x, y];
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

function linePath(positions: PublicGeoJSONPosition[], close = false): string {
  const path = positions.map((position, index) => {
    const [x, y] = projectCRS84Position(position);
    return (index === 0 ? "M " : "L ") + x.toFixed(2) + " " + y.toFixed(2);
  }).join(" ");
  return close ? path + " Z" : path;
}

function polygonPath(rings: PublicGeoJSONPosition[][]): string {
  return rings.map((ring) => linePath(ring, true)).join(" ");
}

function geometryLabel(feature: PublicFeature): string {
  return feature.properties.title + ", " + feature.properties.geometry_role.replaceAll("_", " ") + ", " + feature.geometry.type;
}

function featureHref(eventId: string): string {
  return "#detail/api/" + encodeURIComponent(eventId);
}

function renderGeometry(geometry: PublicGeoJSONGeometry): ReactNode {
  switch (geometry.type) {
    case "Point": {
      const [cx, cy] = projectCRS84Position(geometry.coordinates);
      return (
        <g className="geo-feature__pin-group">
          <circle className="geo-feature__pulse" cx={cx} cy={cy} r="16" fill="none" stroke="var(--kali-teal)" strokeWidth="2" opacity="0.6" />
          <circle className="geo-feature__point" cx={cx} cy={cy} r="8" />
        </g>
      );
    }
    case "MultiPoint":
      return geometry.coordinates.map((position, index) => {
        const [cx, cy] = projectCRS84Position(position);
        return <circle key={index} className="geo-feature__point" cx={cx} cy={cy} r="7" />;
      });
    case "LineString":
      return <path className="geo-feature__line" d={linePath(geometry.coordinates)} />;
    case "MultiLineString":
      return geometry.coordinates.map((line, index) => (
        <path key={index} className="geo-feature__line" d={linePath(line)} />
      ));
    case "Polygon":
      return <path className="geo-feature__polygon" d={polygonPath(geometry.coordinates)} fillRule="evenodd" />;
    case "MultiPolygon":
      return geometry.coordinates.map((polygon, index) => (
        <path key={index} className="geo-feature__polygon" d={polygonPath(polygon)} fillRule="evenodd" />
      ));
  }
}

function formatCoordinates(geometry: PublicGeoJSONGeometry): string {
  return positionsInGeometry(geometry)
    .map((position) => String(position[0]) + ", " + String(position[1]))
    .join(" · ");
}

function eventIdentity(eventId: string, version: number): string {
  return JSON.stringify([eventId, version]);
}

function MapFeature({
  feature,
  event,
  selected,
  onSelect,
}: {
  feature: PublicFeature;
  event: EventView;
  selected: boolean;
  onSelect: () => void;
}) {
  const label = geometryLabel(feature);
  return (
    <g
      className={"geo-feature" + (selected ? " geo-feature--selected" : "")}
      role="button"
      tabIndex={0}
      aria-label={label + "; pilih untuk menyorot laporan dan membuka detail"}
      aria-pressed={selected}
      onClick={onSelect}
      onKeyDown={(keyEvent) => {
        if (keyEvent.key === "Enter" || keyEvent.key === " ") {
          keyEvent.preventDefault();
          onSelect();
        }
      }}
      data-event-id={event.event_id}
      data-feature-id={feature.id}
    >
      <title>{label}</title>
      {renderGeometry(feature.geometry)}
    </g>
  );
}

function OsmTiles() {
  return (
    <div className="map-canvas__tiles" aria-hidden="true">
      <img src="https://tile.openstreetmap.org/11/1631/1058.png" alt="" />
      <img src="https://tile.openstreetmap.org/11/1632/1058.png" alt="" />
      <img src="https://tile.openstreetmap.org/11/1633/1058.png" alt="" />
      <img src="https://tile.openstreetmap.org/11/1631/1059.png" alt="" />
      <img src="https://tile.openstreetmap.org/11/1632/1059.png" alt="" />
      <img src="https://tile.openstreetmap.org/11/1633/1059.png" alt="" />
    </div>
  );
}

export function MapPanel(props: MapPanelProps) {
  const { selection, onReturnToList } = props;
  const legacyScreen = props.mapState === undefined && props.context === undefined && props.visibleEvents === undefined;
  const mapState = props.mapState ?? { status: "idle" as const };
  const context = props.context;
  const feedStatus = props.feedStatus ?? "loaded";
  const visibleEvents = props.visibleEvents ?? [];
  const onSelectApiEvent = props.onSelectApiEvent ?? (() => {});
  const onRetryMap = props.onRetryMap ?? (() => {});
  const isPresentation = selection.kind === "presentation" &&
    (legacyScreen || context?.dataset_mode === "demo");
  const visibleEventsByIdentity = new Map(
    visibleEvents.map((event) => [eventIdentity(event.event_id, event.version), event]),
  );
  const visibleFeatures = mapState.status === "loaded"
    ? mapState.data.features.flatMap((feature) => {
        const event = visibleEventsByIdentity.get(eventIdentity(feature.properties.event_id, feature.properties.version));
        return event ? [{ feature, event }] : [];
      })
    : [];
  const selectedEvent = selection.kind === "api-event" ? selection.event : null;
  const selectedEventIsVisible = selectedEvent !== null &&
    visibleEventsByIdentity.has(eventIdentity(selectedEvent.event_id, selectedEvent.version));
  const selectedEventFeatures = selectedEvent
    ? visibleFeatures.filter(({ feature }) =>
        feature.properties.event_id === selectedEvent.event_id && feature.properties.version === selectedEvent.version)
    : [];
  const selectedFeature = selection.kind === "api-event"
    ? selectedEventFeatures.find(({ feature }) => feature.id === selection.featureId)?.feature ?? selectedEventFeatures[0]?.feature ?? null
    : null;
  const selectedEventHasGeometry = selectedEventFeatures.length > 0;
  const selectedWholeView = selectedEvent?.location_display === "whole_view";

  return (
    <section className="map-panel" aria-labelledby="map-title">
      <header className="panel-heading map-panel__heading">
        <div>
          <p className="section-kicker">{legacyScreen ? "Geometri yang tercatat" : "Lokasi dari laporan"}</p>
          <h2 id="map-title">{legacyScreen ? "Sketsa peta" : "Peta lokasi"}</h2>
        </div>
        <span className="fixture-chip">Tanpa peta dasar</span>
      </header>

      <p className="map-panel__intro">
        {legacyScreen
          ? "Garis hanya muncul untuk segmen yang tercantum pada fixture dokumen. Tidak ada batas bahaya atau area sekitar."
          : "Hanya lokasi dari laporan terlihat yang ditampilkan. Cakupan mengikuti halaman daftar yang dimuat dan filter saat ini; ini bukan hitungan seluruh laporan di Jakarta."}
      </p>

      {selectedEvent && selectedEventIsVisible && mapState.status === "loaded" && !selectedEventHasGeometry && (
        <p className="map-selection-note" role="status">
          {selectedWholeView ? (
            "Lokasi: seluruh peta Jakarta. Laporan ini tidak punya titik di peta; daftar tetap menjadi sumber lengkap. Tanpa titik bukan pernyataan bahwa area aman."
          ) : (
            <>Tidak dipetakan: data peta tidak menyertakan lokasi untuk “{selectedEvent.title}”. Laporan tetap tersedia di daftar; hasil kosong bukan pernyataan bahwa area aman.</>
          )}
        </p>
      )}

      <figure className="map-figure">
        {isPresentation ? (
          <>
            <div className="map-canvas">
              <svg
                className="route-diagram"
                viewBox="0 0 500 500"
                role="img"
                aria-labelledby="route-title route-description"
              >
                <title id="route-title">{fixture.geometry.displayLabel}</title>
                <desc id="route-description">
                  Satu segmen sintetik LineString dari 106.8, -6.2 ke 106.81, -6.21. Diagram bukan peta dasar.
                </desc>
                <path className="route-line" d="M 70 390 L 430 70" />
                <circle className="route-endpoint" cx="70" cy="390" r="7" />
                <circle className="route-endpoint" cx="430" cy="70" r="7" />
                <text className="route-label" x="100" y="250">Jalan Contoh</text>
              </svg>
            </div>
            <figcaption className="map-caption">
              <strong>{fixture.geometry.displayLabel}</strong>
              <span>Segmen pada fixture presentasi sintetis, terpisah dari feature API.</span>
            </figcaption>
            <dl className="coordinate-row">
              <div>
                <dt>Koordinat CRS84 pada fixture</dt>
                <dd>106.8, -6.2 → 106.81, -6.21</dd>
              </div>
              <div>
                <dt>Ketelitian fixture</dt>
                <dd>Tidak diketahui</dd>
              </div>
            </dl>
          </>
        ) : mapState.status === "idle" ? (
          <div className="map-unavailable" role="status">
            <span className="map-unavailable__mark" aria-hidden="true">i</span>
            <h3>Status peta lokasi belum tersedia</h3>
            <p>
              {context === null
                ? "Status dataset belum tersedia; lokasi dari laporan belum dimuat."
                : feedStatus === "loading"
                  ? "Menunggu daftar laporan selesai dimuat sebelum lokasinya dicocokkan."
                  : "Peta lokasi belum dimuat."}
            </p>
          </div>
        ) : mapState.status === "loading" ? (
          <div className="map-unavailable map-unavailable--loading" role="status">
            <span className="map-unavailable__mark" aria-hidden="true">…</span>
            <h3>Memuat lokasi dari laporan…</h3>
            <p>Daftar tetap dapat dibaca saat peta lokasi dimuat.</p>
          </div>
        ) : mapState.status === "unavailable" ? (
          <div className="map-unavailable" role="alert">
            <span className="map-unavailable__mark" aria-hidden="true">!</span>
            <h3>Peta lokasi belum dapat dimuat</h3>
            <p>Kegagalan peta tidak mengubah daftar. Keadaan dan kelengkapan data tidak dapat disimpulkan dari peta.</p>
            <div className="map-state-actions">
              <button className="button button--primary" type="button" onClick={onRetryMap}>Coba lagi memuat peta</button>
              <button className="button button--quiet map-return" type="button" onClick={onReturnToList}>Kembali ke daftar</button>
            </div>
          </div>
        ) : visibleFeatures.length === 0 ? (
          <div className="map-unavailable" role="status">
            <span className="map-unavailable__mark" aria-hidden="true">—</span>
            <h3>Tidak ada lokasi yang cocok pada halaman ini</h3>
            <p>Data peta tidak menyertakan lokasi untuk laporan yang terlihat. Hasil kosong bukan pernyataan bahwa area aman.</p>
            <button className="button button--quiet map-return" type="button" onClick={onReturnToList}>Kembali ke daftar</button>
          </div>
        ) : (
          <>
            <div className="map-canvas map-canvas--osm">
              <OsmTiles />
              <svg
                className="geojson-map"
                viewBox="0 0 500 500"
                role="group"
                aria-label="Titik lokasi yang cocok dengan daftar laporan yang dimuat"
              >
                {visibleFeatures.map(({ feature, event }) => (
                  <MapFeature
                    key={feature.id}
                    feature={feature}
                    event={event}
                    selected={selectedEvent?.event_id === event.event_id && selectedEvent.version === event.version}
                    onSelect={() => onSelectApiEvent(event, feature.id)}
                  />
                ))}
              </svg>
            </div>
            <figcaption className="map-caption">
              {selectedFeature && selectedEvent ? (
                <>
                  <strong>{selectedFeature.properties.title}</strong>
                  <a className="text-link" href={featureHref(selectedEvent.event_id)}>Buka detail laporan</a>
                </>
              ) : (
                <>
                  <strong>{visibleFeatures.length} lokasi pada laporan yang terlihat</strong>
                  <span>Pilih titik, garis, atau bidang untuk menyorot laporan di daftar.</span>
                </>
              )}
            </figcaption>
            <dl className="coordinate-row">
              <div className="coordinate-row__source">
                <dt>Koordinat dari laporan</dt>
                <dd>
                  {selectedFeature
                    ? formatCoordinates(selectedFeature.geometry)
                    : "Pilih lokasi untuk menampilkan semua koordinatnya dari laporan."}
                </dd>
              </div>
              <div>
                <dt>Posisi di peta</dt>
                <dd>Posisi titik sesuai koordinat dari laporan.</dd>
              </div>
            </dl>
          </>
        )}
      </figure>

      {isPresentation ? (
        <footer className="map-legend">
          <span className="legend-line" aria-hidden="true" />
          <span>Segmen fixture presentasi sintetis</span>
          <span className="map-legend__note">Warna dan garis tidak menilai tingkat bahaya.</span>
        </footer>
      ) : mapState.status === "loaded" && visibleFeatures.length > 0 ? (
        <footer className="map-legend">
          <span className="legend-point" aria-hidden="true" />
          <span>Lokasi laporan yang ditampilkan</span>
          <span className="map-legend__note">Hanya laporan terlihat pada halaman yang dimuat.</span>
        </footer>
      ) : (
        <footer className="map-legend map-legend--empty">
          Tanpa peta dasar · hasil kosong bukan pernyataan keselamatan.
        </footer>
      )}
    </section>
  );
}

function insideMapArea(position: PublicGeoJSONPosition): boolean {
  return position[0] >= CRS84_ENVELOPE.west && position[0] <= CRS84_ENVELOPE.east &&
    position[1] >= CRS84_ENVELOPE.south && position[1] <= CRS84_ENVELOPE.north;
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

  return (
    <section className="map-panel" aria-labelledby="record-map-title">
      <header className="panel-heading map-panel__heading">
        <div>
          <p className="section-kicker">Lokasi dari laporan</p>
          <h2 id="record-map-title">Peta lokasi</h2>
        </div>
        <span className="fixture-chip">Tanpa peta dasar</span>
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
            <div className="map-canvas map-canvas--osm">
              <OsmTiles />
              <svg
                className="geojson-map"
                viewBox="0 0 500 500"
                role="group"
                aria-label={"Lokasi laporan " + title}
              >
                {drawable.map((item) => (
                  <g key={item.geometry_id} className="geo-feature" data-geometry-id={item.geometry_id}>
                    <title>{title + ", " + item.role.replaceAll("_", " ") + ", " + item.geometry.type}</title>
                    {renderGeometry(item.geometry)}
                  </g>
                ))}
              </svg>
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
