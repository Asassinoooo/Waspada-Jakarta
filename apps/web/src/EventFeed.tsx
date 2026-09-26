import type { Category, EventView, FreshnessStatus, Lifecycle, PublicContext } from "@waspada/worker/public-contracts";
import { categoryLabel, evidenceLabel, formatEventTime, formatInstant, freshnessLabel, lifecycleLabel } from "./display.js";
import { documentedPresentationFixture as presentation } from "./presentation-fixture.js";
import { MapPanel, type MapSelection } from "./MapPanel.js";

export type FeedStatus = "loading" | "loaded" | "unavailable";
export type MobileDiscoveryPanel = "list" | "map";

export interface FeedFilters {
  category: Category | "all";
  lifecycle: Lifecycle | "all";
  freshness: FreshnessStatus | "all";
}

export const DEFAULT_FEED_FILTERS: FeedFilters = {
  category: "all",
  lifecycle: "all",
  freshness: "all",
};

const categories: readonly Category[] = [
  "crime_personal_security",
  "demonstrations_public_gatherings",
  "crowds_major_events",
  "violence_immediate_threats",
  "disasters_weather",
  "fires_infrastructure_hazards",
  "transport_road_incidents",
  "utilities_essential_services",
  "health_environmental_advisories",
  "group_specific_critical_notices",
];

const lifecycles: readonly Lifecycle[] = ["planned", "ongoing", "resolved", "cancelled", "unknown"];
const freshnessStatuses: readonly FreshnessStatus[] = ["current", "needs_update", "expired"];

export function filterEvents(events: EventView[], query: string, filters: FeedFilters): EventView[] {
  const search = query.trim().toLocaleLowerCase("id");
  return events.filter((event) => {
    const matchesSearch = search.length === 0 ||
      (event.title + " " + event.summary + " " + event.category).toLocaleLowerCase("id").includes(search);
    return matchesSearch &&
      (filters.category === "all" || event.category === filters.category) &&
      (filters.lifecycle === "all" || event.lifecycle === filters.lifecycle) &&
      (filters.freshness === "all" || event.freshness.status === filters.freshness);
  });
}

interface EventFeedProps {
  status: FeedStatus;
  events: EventView[];
  context: PublicContext | null;
  query: string;
  onQueryChange: (value: string) => void;
  filters?: FeedFilters;
  onCategoryChange?: (value: FeedFilters["category"]) => void;
  onLifecycleChange?: (value: FeedFilters["lifecycle"]) => void;
  onFreshnessChange?: (value: FeedFilters["freshness"]) => void;
  onClearFilters?: () => void;
  onRetry: () => void;
  mapSelection: MapSelection;
  onSelectApiEvent: (event: EventView) => void;
  onSelectPresentation: () => void;
  mobilePanel: MobileDiscoveryPanel;
  onMobilePanelChange: (panel: MobileDiscoveryPanel) => void;
}

function sourceSummary(context: PublicContext | null) {
  if (!context) return "Status sumber belum tersedia";
  if (context.sources.length === 0) return "Tidak ada sumber live yang tersambung";
  const unavailable = context.sources.filter((source) => source.health === "unavailable").length;
  if (unavailable > 0) return unavailable + " sumber tidak tersedia";
  return context.sources.length + " sumber tercatat";
}

function apiEventDetailHref(eventId: string) {
  return "#detail/api/" + encodeURIComponent(eventId);
}

export function EventFeed({
  status,
  events,
  context,
  query,
  onQueryChange,
  filters = DEFAULT_FEED_FILTERS,
  onCategoryChange = () => {},
  onLifecycleChange = () => {},
  onFreshnessChange = () => {},
  onClearFilters = () => {},
  onRetry,
  mapSelection,
  onSelectApiEvent,
  onSelectPresentation,
  mobilePanel,
  onMobilePanelChange,
}: EventFeedProps) {
  const matchingEvents = filterEvents(events, query, filters);
  const hasActiveFilters = query.length > 0 || filters.category !== "all" || filters.lifecycle !== "all" || filters.freshness !== "all";
  const presentationSelected = mapSelection.kind === "presentation";

  return (
    <main id="main-content" className="main-shell">
      <section className="page-intro" aria-labelledby="discover-title">
        <div>
          <p className="section-kicker">Jelajah informasi publik</p>
          <h1 id="discover-title">Daftar lebih dulu</h1>
        </div>
        <p className="page-intro__copy">
          Baca asal setiap detail dan waktunya. Peta hanya menampilkan geometri yang tercatat; record lain tetap ada di daftar.
        </p>
      </section>

      <section className="dataset-status" aria-label="Status dataset dan sumber">
        <div className="dataset-status__main">
          <span className="status-marker" aria-hidden="true" />
          <div>
            <strong>{context?.dataset_label === "synthetic" ? "Dataset sintetis" : "Dataset demo"}</strong>
            <span>{sourceSummary(context)}</span>
          </div>
        </div>
        <div className="dataset-status__time">
          <span>Respons API dibuat</span>
          <time dateTime={context?.generated_at}>{formatInstant(context?.generated_at)}</time>
        </div>
      </section>

      <section className="discovery-controls" aria-label="Pencarian daftar lokal">
        <label htmlFor="event-search">Cari dalam contoh API lokal</label>
        <div className="search-control">
          <span aria-hidden="true" className="search-glyph">⌕</span>
          <input
            autoComplete="off"
            id="event-search"
            name="q"
            type="search"
            value={query}
            onChange={(event) => onQueryChange(event.currentTarget.value)}
            placeholder="contoh: pemberitahuan…"
          />
          {query.length > 0 && (
            <button className="search-clear" type="button" onClick={() => onQueryChange("")}>
              Hapus
            </button>
          )}
        </div>
        <fieldset className="feed-filters" aria-describedby="feed-filter-help">
          <legend>Filter daftar</legend>
          <div className="feed-filters__fields">
            <div className="feed-filter">
              <label htmlFor="event-category">Kategori</label>
              <select
                id="event-category"
                name="category"
                value={filters.category}
                onChange={(event) => onCategoryChange(event.currentTarget.value as FeedFilters["category"])}
              >
                <option value="all">Semua kategori</option>
                {categories.map((category) => <option key={category} value={category}>{categoryLabel(category)}</option>)}
              </select>
            </div>
            <div className="feed-filter">
              <label htmlFor="event-lifecycle">Siklus</label>
              <select
                id="event-lifecycle"
                name="lifecycle"
                value={filters.lifecycle}
                onChange={(event) => onLifecycleChange(event.currentTarget.value as FeedFilters["lifecycle"])}
              >
                <option value="all">Semua siklus</option>
                {lifecycles.map((lifecycle) => <option key={lifecycle} value={lifecycle}>{lifecycleLabel(lifecycle)}</option>)}
              </select>
            </div>
            <div className="feed-filter">
              <label htmlFor="event-freshness">Kesegaran</label>
              <select
                id="event-freshness"
                name="freshness"
                value={filters.freshness}
                onChange={(event) => onFreshnessChange(event.currentTarget.value as FeedFilters["freshness"])}
              >
                <option value="all">Semua status kesegaran</option>
                {freshnessStatuses.map((freshness) => <option key={freshness} value={freshness}>{freshnessLabel(freshness)}</option>)}
              </select>
            </div>
          </div>
          <button className="button button--quiet feed-filters__clear" type="button" onClick={onClearFilters} disabled={!hasActiveFilters}>
            Hapus semua filter dan pencarian
          </button>
        </fieldset>
        <p className="search-help" id="feed-filter-help">
          {status === "loaded"
            ? "Pencarian dan filter hanya berlaku pada " + events.length + " record yang sudah dimuat dari halaman API ini. Ini bukan hitungan seluruh insiden di Jakarta."
            : "Pencarian dan filter hanya berlaku pada record yang sudah dimuat dari halaman API ini."}
        </p>
      </section>

      <div className="mobile-view-switch" role="group" aria-label="Tampilan jelajah">
        <button
          type="button"
          aria-pressed={mobilePanel === "list"}
          onClick={() => onMobilePanelChange("list")}
        >
          Daftar
        </button>
        <button
          type="button"
          aria-pressed={mobilePanel === "map"}
          onClick={() => onMobilePanelChange("map")}
        >
          Peta
        </button>
      </div>

      <div className="discovery-grid" data-mobile-panel={mobilePanel}>
        <section className="feed-panel" aria-labelledby="feed-title">
          <header className="panel-heading">
            <div>
              <p className="section-kicker">Data API lokal</p>
              <h2 id="feed-title">Daftar contoh</h2>
            </div>
            {status === "loaded" && (
              <span className="count-chip" aria-live="polite">
                {matchingEvents.length} cocok dari {events.length} record dimuat
              </span>
            )}
          </header>

          {status === "loading" && (
            <div className="state-panel state-panel--loading" role="status">
              <span className="loading-rule" aria-hidden="true" />
              <strong>Memuat record sintetis…</strong>
              <span>Data yang tersedia tetap diberi label demo.</span>
            </div>
          )}

          {status === "unavailable" && (
            <div className="state-panel state-panel--error" role="alert">
              <strong>API lokal tidak dapat dijangkau.</strong>
              <p>Daftar belum tersedia; keadaan keselamatan tidak diketahui.</p>
              <button className="button button--primary" type="button" onClick={onRetry}>Coba lagi</button>
            </div>
          )}

          {status === "loaded" && events.length === 0 && (
            <div className="state-panel" role="status">
              <strong>Belum ada record untuk ditampilkan.</strong>
              <p>Tidak ada laporan yang cocok bukan pernyataan bahwa area aman.</p>
            </div>
          )}

          {status === "loaded" && events.length > 0 && matchingEvents.length === 0 && (
            <div className="state-panel" role="status">
              <strong>Tidak ada laporan yang cocok dengan pencarian dan filter ini.</strong>
              <p>Hasil kosong bukan pernyataan bahwa area aman.</p>
              <button className="button button--quiet" type="button" onClick={onClearFilters}>Hapus semua filter dan pencarian</button>
            </div>
          )}

          {status === "loaded" && matchingEvents.length > 0 && (
            <ul className="event-list" aria-label="Record event dari API lokal">
              {matchingEvents.map((event) => {
                const selected = mapSelection.kind === "api-event" && mapSelection.event.event_id === event.event_id;
                return (
                  <li key={event.event_id}>
                    <article className={"event-card" + (selected ? " event-card--selected" : "")}>
                      <div className="event-card__topline">
                        <span className="synthetic-label">Contoh sintetis dari API</span>
                        <span className="event-card__version">v{event.version}</span>
                      </div>
                      <button
                        className="event-card__select"
                        type="button"
                        aria-pressed={selected}
                        onClick={() => onSelectApiEvent(event)}
                      >
                        <h3>{event.title}</h3>
                        <p>{event.summary}</p>
                      </button>
                      <dl className="event-card__facts">
                        <div><dt>Kategori</dt><dd>{categoryLabel(event.category)}</dd></div>
                        <div><dt>Siklus</dt><dd>{lifecycleLabel(event.lifecycle)}</dd></div>
                        <div><dt>Kesegaran</dt><dd>{freshnessLabel(event.freshness.status)}</dd></div>
                        <div><dt>Bukti</dt><dd>{evidenceLabel(event.claims[0]?.evidence_label)}</dd></div>
                        <div><dt>Kejadian</dt><dd>{formatEventTime(event)}</dd></div>
                        <div><dt>Relevansi</dt><dd>Tidak dinilai</dd></div>
                      </dl>
                      <a className="text-link" href={apiEventDetailHref(event.event_id)}>Buka detail record API</a>
                    </article>
                  </li>
                );
              })}
            </ul>
          )}

          <section className={"presentation-card" + (presentationSelected ? " presentation-card--selected" : "")} aria-labelledby="presentation-title">
            <div className="presentation-card__rule" aria-hidden="true" />
            <p className="section-kicker">Contoh terpisah dari API</p>
            <h3 id="presentation-title">{presentation.event.title}</h3>
            <p>Detail, bukti, dan satu segmen geometri yang tercatat pada fixture dokumentasi.</p>
            <div className="presentation-card__actions">
              <button
                className="button button--quiet"
                type="button"
                aria-pressed={presentationSelected}
                onClick={onSelectPresentation}
              >
                {presentationSelected ? "Segmen dipilih" : "Tampilkan segmen"}
              </button>
              <a className="text-link" href="#detail/presentation">Buka detail fixture</a>
            </div>
          </section>
        </section>

        <div className="map-column">
          <MapPanel
            selection={mapSelection}
            onReturnToList={() => onMobilePanelChange("list")}
          />
        </div>
      </div>

      <p className="safety-note">
        Kekosongan data, peta, atau sumber tidak memastikan kondisi aman. Contoh ini tidak memberi peringatan langsung.
      </p>
    </main>
  );
}
