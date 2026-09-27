import type { EventView, PublicContext, PublicFeature, PublicFeatureCollection, PublicGeoJSONGeometry, PublicGeoJSONPosition } from "@waspada/worker/public-contracts";
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
      return <circle className="geo-feature__point" cx={cx} cy={cy} r="7" />;
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

function formatCoordinates(feature: PublicFeature): string {
  return positionsInGeometry(feature.geometry)
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
      aria-label={label + "; pilih untuk menyorot record dan membuka detail"}
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

  return (
    <section className="map-panel" aria-labelledby="map-title">
      <header className="panel-heading map-panel__heading">
        <div>
          <p className="section-kicker">{legacyScreen ? "Geometri yang tercatat" : "Geometri dari respons API"}</p>
          <h2 id="map-title">{legacyScreen ? "Sketsa peta" : "Peta koordinat CRS84"}</h2>
        </div>
        <span className="fixture-chip">Tanpa peta dasar</span>
      </header>

      <p className="map-panel__intro">
        {legacyScreen
          ? "Garis hanya muncul untuk segmen yang tercantum pada fixture dokumen. Tidak ada batas bahaya atau area sekitar."
          : "Hanya geometri yang dikembalikan API untuk record terlihat yang ditampilkan. Cakupan mengikuti halaman daftar yang dimuat dan filter saat ini; ini bukan hitungan seluruh laporan di Jakarta."}
      </p>

      {selectedEvent && selectedEventIsVisible && mapState.status === "loaded" && !selectedEventHasGeometry && (
        <p className="map-selection-note" role="status">
          Tidak dipetakan: respons GeoJSON tidak menyertakan geometri untuk “{selectedEvent.title}”. Record tetap tersedia di daftar; hasil kosong bukan pernyataan bahwa area aman.
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
        ) : legacyScreen && selection.kind === "api-event" ? (
          <div className="map-unavailable" role="status">
            <span className="map-unavailable__mark" aria-hidden="true">—</span>
            <h3>{selection.event.title}</h3>
            <p>Tidak dipetakan. Record API ini tidak menyertakan geometri; daftar tetap tersedia sebagai alternatif lengkap.</p>
            <p className="supporting-note">Tidak adanya geometri bukan pernyataan bahwa suatu area aman.</p>
            <button className="button button--quiet map-return" type="button" onClick={onReturnToList}>Kembali ke daftar</button>
          </div>
        ) : mapState.status === "idle" ? (
          <div className="map-unavailable" role="status">
            <span className="map-unavailable__mark" aria-hidden="true">i</span>
            <h3>Status peta koordinat belum tersedia</h3>
            <p>
              {context === null
                ? "Status dataset belum tersedia; geometri API belum dimuat."
                : feedStatus === "loading"
                  ? "Menunggu daftar API selesai dimuat sebelum geometri dicocokkan."
                  : "Peta koordinat belum dimuat."}
            </p>
          </div>
        ) : mapState.status === "loading" ? (
          <div className="map-unavailable map-unavailable--loading" role="status">
            <span className="map-unavailable__mark" aria-hidden="true">…</span>
            <h3>Memuat geometri dari API…</h3>
            <p>Daftar tetap dapat dibaca saat peta koordinat dimuat.</p>
          </div>
        ) : mapState.status === "unavailable" ? (
          <div className="map-unavailable" role="alert">
            <span className="map-unavailable__mark" aria-hidden="true">!</span>
            <h3>Peta koordinat belum dapat dimuat</h3>
            <p>Kegagalan peta tidak mengubah daftar. Keadaan dan kelengkapan data tidak dapat disimpulkan dari peta.</p>
            <div className="map-state-actions">
              <button className="button button--primary" type="button" onClick={onRetryMap}>Coba lagi memuat peta</button>
              <button className="button button--quiet map-return" type="button" onClick={onReturnToList}>Kembali ke daftar</button>
            </div>
          </div>
        ) : visibleFeatures.length === 0 ? (
          <div className="map-unavailable" role="status">
            <span className="map-unavailable__mark" aria-hidden="true">—</span>
            <h3>Tidak ada geometri yang cocok pada halaman ini</h3>
            <p>Respons GeoJSON tidak menyertakan geometri untuk record yang terlihat. Hasil kosong bukan pernyataan bahwa area aman.</p>
            <button className="button button--quiet map-return" type="button" onClick={onReturnToList}>Kembali ke daftar</button>
          </div>
        ) : (
          <>
            <div className="map-canvas">
              <svg
                className="geojson-map"
                viewBox="0 0 500 500"
                role="group"
                aria-label="Feature CRS84 yang cocok dengan daftar API dimuat"
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
                  <a className="text-link" href={featureHref(selectedEvent.event_id)}>Buka detail record API</a>
                </>
              ) : (
                <>
                  <strong>{visibleFeatures.length} geometri pada record yang terlihat</strong>
                  <span>Pilih titik, garis, atau bidang untuk menyorot record di daftar.</span>
                </>
              )}
            </figcaption>
            <dl className="coordinate-row">
              <div className="coordinate-row__source">
                <dt>Koordinat CRS84 dari respons API</dt>
                <dd>
                  {selectedFeature
                    ? formatCoordinates(selectedFeature)
                    : "Pilih geometri untuk menampilkan semua koordinatnya seperti dikembalikan API."}
                </dd>
              </div>
              <div>
                <dt>Proyeksi gambar</dt>
                <dd>Equirektangular lokal; posisi sumber tidak diubah.</dd>
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
          <span>Feature API yang dikembalikan</span>
          <span className="map-legend__note">Hanya record terlihat pada halaman yang dimuat.</span>
        </footer>
      ) : (
        <footer className="map-legend map-legend--empty">
          Tanpa peta dasar · hasil kosong bukan pernyataan keselamatan.
        </footer>
      )}
    </section>
  );
}
