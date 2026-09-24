import type { EventView } from "@waspada/worker/public-contracts";
import { documentedPresentationFixture as fixture } from "./presentation-fixture.js";

export type MapSelection =
  | { kind: "none" }
  | { kind: "presentation" }
  | { kind: "api-event"; event: EventView };

interface MapPanelProps {
  selection: MapSelection;
  onReturnToList: () => void;
}

export function MapPanel({ selection, onReturnToList }: MapPanelProps) {
  const isUnselected = selection.kind === "none";
  const isPresentation = selection.kind === "presentation";

  return (
    <section className="map-panel" aria-labelledby="map-title">
      <header className="panel-heading map-panel__heading">
        <div>
          <p className="section-kicker">Geometri yang tercatat</p>
          <h2 id="map-title">Sketsa peta</h2>
        </div>
        <span className="fixture-chip">Tanpa peta dasar</span>
      </header>

      <p className="map-panel__intro">
        Garis hanya muncul untuk segmen yang tercantum pada fixture dokumen. Tidak ada batas bahaya atau area sekitar.
      </p>

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
              <span>Segmen pada fixture presentasi, bukan lokasi live atau geometri dari API.</span>
            </figcaption>
            <dl className="coordinate-row">
              <div>
                <dt>Koordinat CRS84</dt>
                <dd>106.8, -6.2 → 106.81, -6.21</dd>
              </div>
              <div>
                <dt>Ketelitian fixture</dt>
                <dd>Tidak diketahui</dd>
              </div>
            </dl>
          </>
        ) : selection.kind === "api-event" ? (
          <div className="map-unavailable" role="status">
            <span className="map-unavailable__mark" aria-hidden="true">—</span>
            <h3>{selection.event.title}</h3>
            <p>
              Tidak dipetakan. Record API ini tidak menyertakan geometri; daftar tetap tersedia sebagai alternatif lengkap.
            </p>
            <p className="supporting-note">Tidak adanya geometri bukan pernyataan bahwa suatu area aman.</p>
            <button className="button button--quiet map-return" type="button" onClick={onReturnToList}>
              Kembali ke daftar
            </button>
          </div>
        ) : (
          <div className="map-unavailable" role="status">
            <span className="map-unavailable__mark" aria-hidden="true">—</span>
            <h3>Belum ada segmen dipilih</h3>
            <p>Pilih “Tampilkan segmen” pada fixture presentasi di daftar untuk melihat geometri yang didokumentasikan.</p>
            <p className="supporting-note">Record API yang tersedia tidak memuat geometri; daftar tetap menjadi alternatif lengkap.</p>
          </div>
        )}
      </figure>

      {isPresentation ? (
        <footer className="map-legend">
          <span className="legend-line" aria-hidden="true" />
          <span>Segmen rute yang didokumentasikan</span>
          <span className="map-legend__note">Warna dan garis tidak menilai tingkat bahaya.</span>
        </footer>
      ) : isUnselected ? (
        <footer className="map-legend map-legend--empty">Belum ada geometri dipilih.</footer>
      ) : (
        <footer className="map-legend map-legend--empty">Record API ini tidak memuat geometri.</footer>
      )}
    </section>
  );
}
