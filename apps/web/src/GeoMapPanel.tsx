// PERF-09b: the GeoJSON map panel (point, line and polygon features of the feed) and its demo presentation branch. It lives
// apart from MapPanel.tsx so the map home does not carry this component or the presentation fixture. The presentation
// detail (lazy) and the moderator review (lazy) import it; the map home does not.
import type { EventView, PublicContext, PublicFeature } from "@waspada/worker/public-contracts";
import type { FeedStatus } from "./EventFeed.js";
import { documentedPresentationFixture as fixture } from "./presentation-fixture.js";
import { BasemapTiles, formatCoordinates, JAKARTA_MAP_VIEW, renderGeometry, VIEW_SIZE, type GeoJSONMapState, type MapSelection } from "./MapPanel.js";


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

function geometryLabel(feature: PublicFeature): string {
  return feature.properties.title + ", " + feature.properties.geometry_role.replaceAll("_", " ") + ", " + feature.geometry.type;
}

function featureHref(eventId: string): string {
  return "#detail/api/" + encodeURIComponent(eventId);
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
  // Basemap tiles are drawn only in the loaded, non-fixture branch below.
  const showsBaseMap = !isPresentation && mapState.status === "loaded" && visibleFeatures.length > 0;

  return (
    <section className="map-panel" aria-labelledby="map-title">
      <header className="panel-heading map-panel__heading">
        <div>
          <p className="section-kicker">{legacyScreen ? "Geometri yang tercatat" : "Lokasi dari laporan"}</p>
          <h2 id="map-title">{legacyScreen ? "Sketsa peta" : "Peta lokasi"}</h2>
        </div>
        {!showsBaseMap && <span className="fixture-chip">Tanpa peta dasar</span>}
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
                <dt>Koordinat contoh</dt>
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
              <div className="map-canvas__stage">
                <BasemapTiles view={JAKARTA_MAP_VIEW} className="map-canvas__tiles" tileClassName="map-canvas__tile" />
                <svg
                  className="geojson-map"
                  viewBox={`0 0 ${VIEW_SIZE} ${VIEW_SIZE}`}
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
              <a className="map-attribution" href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">
                © OpenStreetMap contributors
              </a>
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
