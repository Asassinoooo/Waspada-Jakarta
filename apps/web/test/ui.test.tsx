import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { BriefingResponse, EventDetail as EventDetailRecord, EventView, HistoryPage, PublicContext } from "@waspada/worker/public-contracts";
import type { SessionEnvelope } from "@waspada/worker/account-contracts";
import { discoveryStateFromSearch, discoveryStateReducer, PresentationRoute, routeFromHash } from "../src/App.js";
import { accountMenuEntries, SiteFooter, SiteHeader } from "../src/AppShell.js";
import { BriefingResultsView, isCurrentBriefingRequest } from "../src/BriefingResults.js";
import { EventDetail } from "../src/EventDetail.js";
import { DEFAULT_FEED_FILTERS, EventFeed, filterEvents, type FeedFilters } from "../src/EventFeed.js";
import { ModeratorReview } from "../src/ModeratorReview.js";
import type { GeoJSONMapState, MapSelection } from "../src/MapPanel.js";
import { emptyInterests } from "../src/preferences-store.js";

const demoContext: PublicContext = {
  dataset_mode: "demo",
  dataset_label: "synthetic",
  generated_at: "2026-09-24T10:00:00.000Z",
  sources: [],
};

const liveContext: PublicContext = {
  ...demoContext,
  dataset_mode: "live",
  dataset_label: "live",
};

const anonymousSession: SessionEnvelope = {
  version: "account-v1",
  status: "anonymous",
  password_login_available: true,
  registration_available: true,
  csrf_token: null,
  user: null,
};

function sessionWithRole(role: "user" | "moderator" | "admin"): SessionEnvelope {
  return {
    ...anonymousSession,
    status: "authenticated",
    csrf_token: "csrf-token-for-menu-tests-0000",
    user: {
      id: "account-menu-" + role,
      display_name: "Uji Menu",
      email: "menu@example.test",
      role,
      active: true,
      onboarding_version: 1,
      onboarding_completed_at: "2026-10-15T04:00:00.000Z",
      version: 1,
    },
  };
}

const sampleEvent: EventView = {
  event_id: "synthetic-demo-01",
  version: 1,
  title: "Contoh fiktif: pemberitahuan kelompok",
  summary: "Data contoh untuk pengujian UI.",
  category: "group_specific_critical_notices",
  tags: [{ namespace: "topic", value: "synthetic_demo" }],
  lifecycle: "unknown",
  freshness: {
    status: "needs_update",
    evaluated_at: "2026-09-24T00:00:00.000Z",
    review_due_at: null,
    basis: "unknown",
  },
  event_time: { start: null, end: null, precision: "unknown" },
  validity: { valid_from: null, valid_until: null },
  scope: { places: [], services: [], institutions: [], audiences: [] },
  claims: [],
  impacts: [],
  published_at: "2026-09-24T00:00:00.000Z",
};

const sampleDetail: EventDetailRecord = { ...sampleEvent, geometries: [] };

const testOnlyEvents: EventView[] = [
  {
    ...sampleEvent,
    event_id: "test-weather-current",
    title: "Uji cuaca saat ini",
    category: "disasters_weather",
    lifecycle: "ongoing",
    freshness: { ...sampleEvent.freshness, status: "current" },
  },
  {
    ...sampleEvent,
    event_id: "test-transport-expired",
    title: "Uji transportasi selesai",
    category: "transport_road_incidents",
    lifecycle: "resolved",
    freshness: { ...sampleEvent.freshness, status: "expired" },
  },
  {
    ...sampleEvent,
    event_id: "test-weather-expired",
    title: "Uji cuaca lewat tinjau",
    category: "disasters_weather",
    lifecycle: "ongoing",
    freshness: { ...sampleEvent.freshness, status: "expired" },
  },
  {
    ...sampleEvent,
    event_id: "test-crowd-needs-update",
    title: "Uji kerumunan perlu diperbarui",
    category: "crowds_major_events",
    lifecycle: "cancelled",
    freshness: { ...sampleEvent.freshness, status: "needs_update" },
  },
];

const sampleHistory: HistoryPage = {
  data: [{
    event_id: sampleEvent.event_id,
    version: sampleEvent.version,
    change_type: "published",
    changed_at: sampleEvent.published_at,
    summary: "Versi contoh sintetis dimuat untuk demonstrasi antarmuka.",
  }],
  page: { next_cursor: null, cursor_expires_at: null },
};

const briefingEvent: EventView = {
  ...sampleEvent,
  event_id: "public/id?# &",
  title: "Peristiwa fiktif untuk uji briefing",
  category: "disasters_weather",
  lifecycle: "ongoing",
  freshness: { ...sampleEvent.freshness, status: "current" },
  event_time: { start: "2026-09-25T04:00:00.000Z", end: null, precision: "exact" },
  published_at: "2026-09-25T04:05:00.000Z",
};

const sampleBriefing: BriefingResponse = {
  items: [{ event: briefingEvent, relevance_reasons: ["Cocok dengan kategori yang Anda pilih."] }],
  generated_at: "2026-09-25T04:06:00.000Z",
};

function renderFeed(options: {
  status?: "loading" | "loaded" | "unavailable";
  events?: EventView[];
  query?: string;
  filters?: FeedFilters;
  selection?: MapSelection;
  context?: PublicContext | null;
  geoJSONState?: GeoJSONMapState;
} = {}) {
  return renderToStaticMarkup(
    <EventFeed
      status={options.status ?? "loaded"}
      events={options.events ?? [sampleEvent]}
      context={demoContext}
      query={options.query ?? ""}
      onQueryChange={() => {}}
      filters={options.filters ?? DEFAULT_FEED_FILTERS}
      onCategoryChange={() => {}}
      onLifecycleChange={() => {}}
      onFreshnessChange={() => {}}
      onClearFilters={() => {}}
      onRetry={() => {}}
      mapSelection={options.selection ?? { kind: "none" }}
      geoJSONState={options.geoJSONState ?? { status: "loaded", data: { type: "FeatureCollection", features: [] } }}
      onSelectApiEvent={() => {}}
      onRetryMap={() => {}}
      onSelectPresentation={() => {}}
      mobilePanel="list"
      onMobilePanelChange={() => {}}
    />,
  );
}

test("persistent shell and discovery expose synthetic dataset and linked list/map controls", () => {
  const header = renderToStaticMarkup(<SiteHeader route={{ screen: "discover" }} context={demoContext} />);
  const page = renderFeed();

  assert.match(header, /DEMO — data sintetis; bukan peringatan langsung/);
  assert.match(page, /Tidak ada sumber live yang tersambung/);
  assert.match(header, /Lewati ke konten utama/);
  assert.match(page, /Contoh fiktif: pemberitahuan kelompok/);
  assert.match(page, /aria-label="Tampilan jelajah"/);
  assert.match(page, /aria-pressed="true">Daftar/);
  assert.match(page, /aria-pressed="false">Peta/);
  assert.match(page, /Siklus/);
  assert.match(page, /Kesegaran/);
  assert.match(page, /Bukti/);
  assert.match(page, /Relevansi/);
  assert.match(page, /Tidak ada geometri yang cocok pada halaman ini/);
  assert.match(page, /aria-pressed="false">Tampilkan fixture/);
  assert.doesNotMatch(page, /route-diagram/);
  const selectedApi = renderFeed({ selection: { kind: "api-event", event: sampleEvent } });
  assert.match(selectedApi, /Tidak dipetakan/);
  const selectedPresentation = renderFeed({ selection: { kind: "presentation" } });
  assert.match(selectedPresentation, /route-diagram/);
  assert.match(selectedPresentation, /aria-pressed="true">Segmen dipilih/);
  assert.match(selectedPresentation, /106\.8, -6\.2 → 106\.81, -6\.21/);
});

test("EventFeed flows incident records naturally below map without floating popup drawer", () => {
  const page = renderFeed();

  // Floating popup drawer and "Ciutkan ke peta" are removed
  assert.doesNotMatch(page, /Ciutkan ke peta/);
  assert.doesNotMatch(page, /feed-panel--floating-sheet/);
  assert.doesNotMatch(page, /feed-drawer__floating-trigger/);
  assert.doesNotMatch(page, /feed-drawer__toggle-btn/);

  // Map column precedes feed panel so incident records flow below the map on desktop
  const mapIdx = page.indexOf('class="map-column"');
  const feedIdx = page.indexOf('class="feed-panel"');
  assert.ok(mapIdx !== -1, "map-column should exist");
  assert.ok(feedIdx !== -1, "feed-panel should exist");
  assert.ok(mapIdx < feedIdx, "map-column must precede feed-panel for natural below-map flow");

  // Mobile view switch between Daftar and Peta is present
  assert.match(page, /class="mobile-view-switch" role="group" aria-label="Tampilan jelajah"/);
  assert.match(page, />Daftar<\/button>/);
  assert.match(page, />Peta<\/button>/);
});

function primaryNavLinks(markup: string) {
  const nav = markup.match(/<nav class="primary-nav" aria-label="Navigasi utama">([\s\S]*?)<\/nav>/u)?.[1] ?? "";
  return [...nav.matchAll(/<a href="([^"]+)"( aria-current="page")?>[\s\S]*?<span>([^<]+)<\/span><\/a>/gu)].map((match) => ({
    href: match[1] ?? "",
    current: match[2] !== undefined,
    label: match[3] ?? "",
  }));
}

test("update centre keeps direct hash navigation and marks its current nav item", () => {
  assert.deepEqual(routeFromHash("#pembaruan"), { screen: "updates" });
  const header = renderToStaticMarkup(<SiteHeader route={{ screen: "updates" }} context={liveContext} />);
  const links = primaryNavLinks(header);
  assert.equal(links.find((link) => link.href === "#pembaruan")?.current, true);
  assert.equal(links.filter((link) => link.current).length, 1);
});

test("the primary navigation has exactly three destinations: Peta, Pembaruan and Area saya", () => {
  const header = renderToStaticMarkup(<SiteHeader route={{ screen: "preferences" }} context={liveContext} />);
  const links = primaryNavLinks(header);
  assert.deepEqual(links.map((link) => [link.href, link.label]), [
    ["#peta", "Peta"],
    ["#pembaruan", "Pembaruan"],
    ["#ringkasan-saya", "Area saya"],
  ]);
  assert.equal(links.find((link) => link.current)?.label, "Area saya");
});

test("account screens keep the account entry in the header menu and out of the primary nav", () => {
  assert.deepEqual(routeFromHash("#masuk"), { screen: "login" });
  assert.deepEqual(routeFromHash("#masuk?return_to=%23admin"), { screen: "login", returnTo: "#admin" });
  assert.deepEqual(routeFromHash("#masuk?return_to=https%3A%2F%2Fexample.test"), { screen: "login" });
  assert.deepEqual(routeFromHash("#mulai"), { screen: "onboarding" });
  assert.deepEqual(routeFromHash("#akun"), { screen: "account" });

  const header = renderToStaticMarkup(<SiteHeader route={{ screen: "account" }} context={liveContext} />);
  assert.equal(primaryNavLinks(header).length, 3);
  assert.match(header, /aria-haspopup="menu"[^>]*>Akun</u);
});

test("the public map is the home route and every legacy public hash resolves to it", () => {
  for (const hash of ["", "#peta", "#beranda", "#jelajah", "#laporan-publik", "#laporan-publik-demo", "#publik-demo", "#tidak-dikenal"]) {
    assert.deepEqual(routeFromHash(hash), { screen: "discover" }, hash);
  }
  assert.deepEqual(routeFromHash("#bantuan"), { screen: "help" });
  assert.deepEqual(routeFromHash("#panduan"), { screen: "help", section: "panduan" });
  assert.deepEqual(routeFromHash("#privasi"), { screen: "help", section: "privasi" });
  assert.deepEqual(routeFromHash("#admin"), { screen: "admin" });
  assert.deepEqual(routeFromHash("#admin-workspace"), { screen: "admin" });
  assert.deepEqual(routeFromHash("#tinjau-bukti"), { screen: "review" });
  assert.deepEqual(routeFromHash("#alur-agen"), { screen: "pipeline-flow" });
  assert.deepEqual(routeFromHash("#visualisasi-3d"), { screen: "embedding-3d" });
  assert.deepEqual(routeFromHash("#embedding-3d"), { screen: "embedding-3d" });
  assert.deepEqual(routeFromHash("#demo-sumber"), { screen: "source-preview" });
  assert.deepEqual(routeFromHash("#detail/api/public%2Fid%3F"), { screen: "detail-api", eventId: "public/id?" });
  assert.deepEqual(routeFromHash("#detail/api/%ZZ"), { screen: "detail-api", eventId: "" });
  // A production/SSR import cannot open the development-only private inspector.
  assert.deepEqual(routeFromHash("#pipeline-lokal"), { screen: "discover" });
});

test("admin tab hashes map onto the existing admin screens until the workspace tabs land", () => {
  assert.deepEqual(routeFromHash("#admin/ringkasan"), { screen: "admin" });
  assert.deepEqual(routeFromHash("#admin/akun"), { screen: "admin" });
  assert.deepEqual(routeFromHash("#admin/tinjau"), { screen: "review" });
  assert.deepEqual(routeFromHash("#admin/alur"), { screen: "pipeline-flow" });
  assert.deepEqual(routeFromHash("#admin/embedding"), { screen: "embedding-3d" });
  assert.deepEqual(routeFromHash("#admin/sumber"), { screen: "source-preview" });
  assert.deepEqual(routeFromHash("#admin/tidak-ada"), { screen: "admin" });
});

test("the public header shows one dataset badge and no admin, review or source links", () => {
  const demo = renderToStaticMarkup(<SiteHeader route={{ screen: "discover" }} context={demoContext} />);
  assert.match(demo, /popover__trigger site-header__badge badge badge--warning[^>]*>Data contoh<\/button>/u);
  assert.match(demo, /DEMO — data sintetis; bukan peringatan langsung/);
  assert.match(demo, /Lewati ke konten utama/);
  assert.doesNotMatch(demo, /href="#(admin|tinjau-bukti|demo-sumber|alur-agen|visualisasi-3d|pipeline-lokal|laporan-publik-demo)/u);

  const live = renderToStaticMarkup(<SiteHeader route={{ screen: "discover" }} context={liveContext} />);
  assert.match(live, />Langsung<\/button>/u);
  assert.match(live, /LIVE — record berasal dari dataset live API/);
  assert.doesNotMatch(live, /DEMO —/);

  const unknown = renderToStaticMarkup(<SiteHeader route={{ screen: "discover" }} context={null} />);
  assert.match(unknown, />Status data<\/button>/u);
  assert.match(unknown, /Status dataset tidak tersedia/);
  assert.match(unknown, /Jenis dataset belum dapat diverifikasi/);
  assert.doesNotMatch(unknown, /Mode demo|Mode live|DEMO —|LIVE —/);

  const footer = renderToStaticMarkup(<SiteFooter />);
  assert.match(footer, /bukan layanan darurat\. Darurat: 112\./u);
  assert.match(footer, /href="#bantuan">Bantuan<\/a>/u);
  assert.match(footer, /href="#privasi">Privasi<\/a>/u);
  assert.doesNotMatch(footer, /href="#(admin|tinjau-bukti|demo-sumber|alur-agen|visualisasi-3d|laporan-publik-demo|jelajah)/u);
});

test("the account menu offers the admin workspace only to moderators and administrators", () => {
  const labels = (session: SessionEnvelope | null) => accountMenuEntries(session, null).map((entry) => entry.label);
  const entry = (session: SessionEnvelope | null, id: string) => accountMenuEntries(session, null).find((item) => item.id === id);

  assert.deepEqual(labels(null), ["Akun", "Bantuan", "Privasi", "Tentang Waspada"]);
  assert.deepEqual(labels(anonymousSession), ["Masuk", "Bantuan", "Privasi", "Tentang Waspada"]);
  assert.deepEqual(labels(sessionWithRole("user")), ["Akun saya", "Bantuan", "Privasi", "Tentang Waspada"]);
  assert.equal(entry(sessionWithRole("user"), "admin"), undefined);

  assert.equal(entry(sessionWithRole("moderator"), "admin")?.href, "#admin/tinjau");
  assert.equal(entry(sessionWithRole("moderator"), "embedding"), undefined);

  assert.equal(entry(sessionWithRole("admin"), "admin")?.href, "#admin/ringkasan");
  assert.equal(entry(sessionWithRole("admin"), "embedding")?.href, "#admin/embedding");
  assert.equal(entry(sessionWithRole("admin"), "sources")?.href, "#admin/sumber");

  const inactiveAdmin = { ...sessionWithRole("admin"), user: { ...sessionWithRole("admin").user!, active: false } };
  assert.equal(entry(inactiveAdmin, "admin"), undefined);
  assert.equal(accountMenuEntries(null, "Gelap").at(-1)?.label, "Tema: Gelap");
});

test("briefing gates unknown, demo, and empty-interest contexts without enabling a request", () => {
  const interests = { ...emptyInterests(), places: ["Pondok Labu"] };
  const unknown = renderToStaticMarkup(
    <BriefingResultsView context={null} interests={interests} state={{ status: "idle" }} onRequest={() => {}} />,
  );
  const demo = renderToStaticMarkup(
    <BriefingResultsView context={demoContext} interests={interests} state={{ status: "idle" }} onRequest={() => {}} />,
  );
  const empty = renderToStaticMarkup(
    <BriefingResultsView context={liveContext} interests={emptyInterests()} state={{ status: "idle" }} onRequest={() => {}} />,
  );
  const idle = renderToStaticMarkup(
    <BriefingResultsView context={liveContext} interests={interests} state={{ status: "idle" }} onRequest={() => {}} />,
  );

  assert.match(unknown, /status dataset belum dapat diverifikasi/);
  assert.doesNotMatch(unknown, /Tampilkan ringkasan|Perbarui ringkasan|Coba lagi/);
  assert.match(demo, /mode demo/);
  assert.match(demo, /Data demo tidak digunakan untuk mencocokkan minat/);
  assert.doesNotMatch(demo, /Tampilkan ringkasan|Perbarui ringkasan|Coba lagi/);
  assert.match(empty, /Pilih setidaknya satu tempat/);
  assert.doesNotMatch(empty, /Tampilkan ringkasan|Perbarui ringkasan|Coba lagi/);
  assert.match(idle, /Briefing belum diminta/);
  assert.match(idle, />Tampilkan ringkasan</);
});

test("briefing renders loading, unavailable, and exact no-match states accessibly", () => {
  const interests = { ...emptyInterests(), categories: ["disasters_weather" as const] };
  const loading = renderToStaticMarkup(
    <BriefingResultsView context={liveContext} interests={interests} state={{ status: "loading" }} onRequest={() => {}} />,
  );
  const unavailable = renderToStaticMarkup(
    <BriefingResultsView context={liveContext} interests={interests} state={{ status: "unavailable" }} onRequest={() => {}} />,
  );
  const noMatch = renderToStaticMarkup(
    <BriefingResultsView
      context={liveContext}
      interests={interests}
      state={{ status: "loaded", data: { items: [], generated_at: sampleBriefing.generated_at } }}
      onRequest={() => {}}
    />,
  );

  assert.match(loading, /aria-busy="true"/);
  assert.match(loading, /Memuat briefing live/);
  assert.match(unavailable, /role="alert"/);
  assert.match(unavailable, /Briefing belum dapat dimuat/);
  assert.match(unavailable, />Coba lagi</);
  assert.match(noMatch, /Belum ada informasi terbit yang cocok dengan minat Anda\./);
  assert.doesNotMatch(noMatch, /semua area aman|semua aman/);
});

test("briefing cards keep category, lifecycle, freshness, event time, and publication time distinct", () => {
  const markup = renderToStaticMarkup(
    <BriefingResultsView
      context={liveContext}
      interests={{ ...emptyInterests(), places: ["Pondok Labu"] }}
      state={{ status: "loaded", data: sampleBriefing }}
      onRequest={() => {}}
    />,
  );
  const eventTime = markup.match(/<dt>Waktu kejadian<\/dt><dd>(.*?)<\/dd>/)?.[1];
  const publishedTime = markup.match(/<dt>Waktu terbit<\/dt><dd>(.*?)<\/dd>/)?.[1];

  assert.match(markup, /Bencana dan cuaca/);
  assert.match(markup, /<dt>Siklus<\/dt><dd>Berlangsung<\/dd>/);
  assert.match(markup, /<dt>Kesegaran<\/dt><dd>Dalam batas tinjau<\/dd>/);
  assert.match(markup, /Mengapa muncul/);
  assert.match(markup, /Cocok dengan kategori yang Anda pilih\./);
  assert.match(markup, /href="#detail\/api\/public%2Fid%3F%23%20%26"/);
  assert.ok(eventTime);
  assert.ok(publishedTime);
  assert.notEqual(eventTime, publishedTime);
  assert.match(markup, /Pembaruan otomatis belum tersedia/);
  assert.doesNotMatch(markup, /fixture|Tidak dinilai/);
});

test("late briefing responses are rejected after the interest or request snapshot changes", () => {
  const original = { sequence: 4, snapshotKey: "live:interest-a" };
  assert.equal(isCurrentBriefingRequest(original, original), true);
  assert.equal(isCurrentBriefingRequest(original, { sequence: 4, snapshotKey: "live:interest-b" }), false);
  assert.equal(isCurrentBriefingRequest(original, { sequence: 5, snapshotKey: "live:interest-a" }), false);
  assert.equal(isCurrentBriefingRequest(original, null), false);
});

test("presentation detail is visible only after the API confirms demo mode", () => {
  const demoDetail = renderToStaticMarkup(<PresentationRoute context={demoContext} />);
  const liveDetail = renderToStaticMarkup(<PresentationRoute context={{ ...demoContext, dataset_mode: "live", dataset_label: "live" }} />);
  const unknownDetail = renderToStaticMarkup(<PresentationRoute context={null} />);

  assert.match(demoDetail, /Bus 12 diversion \(synthetic demo\)/);
  assert.match(liveDetail, /Fixture presentasi hanya tersedia pada dataset demo/);
  assert.doesNotMatch(liveDetail, /Bus 12 diversion|route-diagram/);
  assert.match(unknownDetail, /Status dataset tidak tersedia/);
  assert.match(unknownDetail, /disembunyikan sampai status dataset tersedia/);
  assert.doesNotMatch(unknownDetail, /dataset live|Bus 12 diversion|route-diagram/);
});

test("loading, empty, and unavailable states give honest next steps", () => {
  const loading = renderFeed({ status: "loading", events: [] });
  const empty = renderFeed({ events: [] });
  const noMatch = renderFeed({ query: "tidak-ada" });
  const unavailable = renderFeed({ status: "unavailable", events: [] });

  assert.match(loading, /Memuat record dari API/);
  assert.match(empty, /bukan pernyataan bahwa area aman/);
  assert.match(noMatch, /Tidak ada laporan yang cocok dengan pencarian dan filter ini/);
  assert.match(noMatch, /Hapus semua filter dan pencarian/);
  assert.match(unavailable, /keadaan keselamatan tidak diketahui/);
  assert.match(unavailable, />Coba lagi</);
});

test("loaded-page filters use contract values, preserve search, and combine with AND semantics", () => {
  assert.deepEqual(filterEvents(testOnlyEvents, "", DEFAULT_FEED_FILTERS), testOnlyEvents);
  assert.deepEqual(filterEvents(testOnlyEvents, "", { ...DEFAULT_FEED_FILTERS, category: "disasters_weather" }).map((event) => event.event_id), [
    "test-weather-current",
    "test-weather-expired",
  ]);
  assert.deepEqual(filterEvents(testOnlyEvents, "", { ...DEFAULT_FEED_FILTERS, lifecycle: "resolved" }).map((event) => event.event_id), [
    "test-transport-expired",
  ]);
  assert.deepEqual(filterEvents(testOnlyEvents, "", { ...DEFAULT_FEED_FILTERS, freshness: "expired" }).map((event) => event.event_id), [
    "test-transport-expired",
    "test-weather-expired",
  ]);
  assert.deepEqual(filterEvents(testOnlyEvents, "cuaca", {
    category: "disasters_weather",
    lifecycle: "ongoing",
    freshness: "current",
  }).map((event) => event.event_id), ["test-weather-current"]);
  assert.deepEqual(filterEvents(testOnlyEvents, "uji", {
    category: "disasters_weather",
    lifecycle: "ongoing",
    freshness: "current",
  }).map((event) => event.event_id), ["test-weather-current"]);

  const defaultPage = renderFeed({ events: testOnlyEvents });
  assert.match(defaultPage, /4 cocok dari 4 record dimuat/);
  assert.match(defaultPage, /hanya berlaku pada 4 record yang sudah dimuat dari halaman API ini/);
  assert.match(defaultPage, /bukan hitungan seluruh insiden di Jakarta/);
  assert.match(defaultPage, /name="category"/);
  assert.match(defaultPage, /name="lifecycle"/);
  assert.match(defaultPage, /name="freshness"/);
  assert.match(defaultPage, /Semua kategori/);
  assert.match(defaultPage, /Semua siklus/);
  assert.match(defaultPage, /Semua status kesegaran/);
  assert.match(defaultPage, /<option value="all" selected="">Semua kategori<\/option>/);
  assert.match(defaultPage, /<option value="all" selected="">Semua siklus<\/option>/);
  assert.match(defaultPage, /<option value="all" selected="">Semua status kesegaran<\/option>/);

  const filteredPage = renderFeed({
    events: testOnlyEvents,
    query: "cuaca",
    filters: { category: "disasters_weather", lifecycle: "ongoing", freshness: "current" },
  });
  assert.match(filteredPage, /1 cocok dari 4 record dimuat/);
  assert.match(filteredPage, /Uji cuaca saat ini/);
  assert.doesNotMatch(filteredPage, /Uji transportasi selesai|Uji cuaca lewat tinjau|Uji kerumunan perlu diperbarui/);
});

test("discovery initializes supported feed filters from the URL and ignores unknown values", () => {
  assert.deepEqual(discoveryStateFromSearch("?q=banjir&category=disasters_weather&lifecycle=ongoing&freshness=current"), {
    query: "banjir",
    filters: { category: "disasters_weather", lifecycle: "ongoing", freshness: "current" },
    mapSelection: { kind: "none" },
  });
  assert.deepEqual(discoveryStateFromSearch("?category=unsafe&lifecycle=unknown&freshness=expired"), {
    query: "",
    filters: { category: "all", lifecycle: "unknown", freshness: "expired" },
    mapSelection: { kind: "none" },
  });
});

test("filtered-empty state stays neutral and clear-all resets filters, search, and map selection", () => {
  const filteredEmpty = renderFeed({
    events: testOnlyEvents,
    filters: { category: "health_environmental_advisories", lifecycle: "all", freshness: "all" },
  });
  assert.match(filteredEmpty, /0 cocok dari 4 record dimuat/);
  assert.match(filteredEmpty, /Tidak ada laporan yang cocok dengan pencarian dan filter ini/);
  assert.match(filteredEmpty, /Hasil kosong bukan pernyataan bahwa area aman\./);
  assert.match(filteredEmpty, /Hapus semua filter dan pencarian/);
  assert.doesNotMatch(filteredEmpty, /Belum ada record untuk ditampilkan/);

  const state = {
    query: "cuaca",
    filters: { category: "disasters_weather", lifecycle: "ongoing", freshness: "expired" } as FeedFilters,
    mapSelection: { kind: "api-event", event: testOnlyEvents[2] } as MapSelection,
  };
  const afterSearchChange = discoveryStateReducer(state, { type: "query-changed", query: "transportasi" });
  assert.equal(afterSearchChange.query, "transportasi");
  assert.deepEqual(afterSearchChange.mapSelection, { kind: "none" });

  const afterFilterChange = discoveryStateReducer(state, { type: "category-changed", value: "crowds_major_events" });
  assert.equal(afterFilterChange.filters.category, "crowds_major_events");
  assert.deepEqual(afterFilterChange.mapSelection, { kind: "none" });

  const afterClear = discoveryStateReducer(state, { type: "filters-cleared" });
  assert.equal(afterClear.query, "");
  assert.deepEqual(afterClear.filters, DEFAULT_FEED_FILTERS);
  assert.deepEqual(afterClear.mapSelection, { kind: "none" });
});

test("documented detail keeps evidence times distinct and does not invent history", () => {
  const markup = renderToStaticMarkup(<EventDetail mode="presentation" context={demoContext} />);

  assert.match(markup, /Contoh detail terpisah dari API/);
  assert.match(markup, /Bus 12 diversion \(synthetic demo\)/);
  assert.match(markup, /Waktu sumber diterbitkan/);
  assert.match(markup, /Waktu sistem mengambil sumber/);
  assert.match(markup, /URL fixture/);
  assert.match(markup, /Tidak ada perubahan terdahulu di contoh ini/);
  assert.match(markup, /data: \[\]/);
  assert.match(markup, /Jalan Contoh \(synthetic\)/);
  assert.doesNotMatch(markup, /<a[^>]+example\.invalid/);
});

test("API detail preserves unknown fields as unknown and has no invented geometry", () => {
  const markup = renderToStaticMarkup(
    <EventDetail
      mode="api-event"
      apiDetail={{ eventId: sampleEvent.event_id, status: "loaded", data: sampleDetail }}
      apiHistory={{ eventId: sampleEvent.event_id, status: "loaded", data: sampleHistory }}
      onRetryDetail={() => {}}
      onRetryHistory={() => {}}
      context={demoContext}
    />,
  );

  assert.match(markup, /Detail dari API lokal/);
  assert.match(markup, /Waktu kejadian tidak diketahui/);
  assert.match(markup, /Tidak tersedia pada fixture/);
  assert.match(markup, /Bukti tidak tersedia pada fixture demo ini/);
  assert.match(markup, /Versi contoh sintetis dimuat untuk demonstrasi antarmuka\./);
  assert.match(markup, /fixture demo/);
  assert.match(markup, /Record API ini tidak menyertakan geometri/);
  assert.doesNotMatch(markup, /route-diagram|Didukung laporan independen|Buka sumber publik|example\.invalid/);
});

test("detail stays visible when history is unavailable and exposes history retry", () => {
  const markup = renderToStaticMarkup(
    <EventDetail
      mode="api-event"
      apiDetail={{ eventId: sampleEvent.event_id, status: "loaded", data: sampleDetail }}
      apiHistory={{ eventId: sampleEvent.event_id, status: "unavailable" }}
      onRetryDetail={() => {}}
      onRetryHistory={() => {}}
      context={demoContext}
    />,
  );

  assert.match(markup, /Contoh fiktif: pemberitahuan kelompok/);
  assert.match(markup, /Riwayat belum dapat dimuat/);
  assert.match(markup, /Detail event tetap dapat dibaca/);
  assert.match(markup, /role="alert"/);
  assert.match(markup, />Coba lagi memuat riwayat</);
});

test("detail not-found, unavailable, loading, and empty-history states are explicit", () => {
  const notFound = renderToStaticMarkup(
    <EventDetail
      mode="api-event"
      apiDetail={{ eventId: "missing", status: "not-found" }}
      apiHistory={{ eventId: "missing", status: "not-found" }}
      context={demoContext}
    />,
  );
  const unavailable = renderToStaticMarkup(
    <EventDetail
      mode="api-event"
      apiDetail={{ eventId: "temporary", status: "unavailable" }}
      apiHistory={{ eventId: "temporary", status: "loading" }}
      onRetryDetail={() => {}}
      onRetryHistory={() => {}}
      context={demoContext}
    />,
  );
  const loading = renderToStaticMarkup(
    <EventDetail
      mode="api-event"
      apiDetail={{ eventId: sampleEvent.event_id, status: "loading" }}
      apiHistory={{ eventId: sampleEvent.event_id, status: "loading" }}
      context={demoContext}
    />,
  );
  const emptyHistory = renderToStaticMarkup(
    <EventDetail
      mode="api-event"
      apiDetail={{ eventId: sampleEvent.event_id, status: "loaded", data: sampleDetail }}
      apiHistory={{ eventId: sampleEvent.event_id, status: "loaded", data: { ...sampleHistory, data: [] } }}
      context={demoContext}
    />,
  );

  assert.match(notFound, /Record contoh tidak ditemukan/);
  assert.match(notFound, /Riwayat record tidak ditemukan/);
  assert.doesNotMatch(notFound, /Contoh fiktif: pemberitahuan kelompok/);
  assert.match(unavailable, /Detail contoh belum dapat dimuat/);
  assert.match(unavailable, /Keadaan keselamatan tidak diketahui/);
  assert.match(unavailable, />Coba lagi memuat detail</);
  assert.match(loading, /Memuat record sintetis dari API lokal/);
  assert.match(loading, /Memuat riwayat fixture/);
  assert.match(loading, /role="status"/);
  assert.match(emptyHistory, /Tidak ada entri riwayat pada fixture ini/);
  assert.match(emptyHistory, /tidak menunjukkan keselamatan atau penyelesaian event/);
});

test("moderator presentation is explicitly read-only and has no decision controls", () => {
  const markup = renderToStaticMarkup(<ModeratorReview />);

  assert.match(markup, /Bukan antrean moderator/);
  assert.match(markup, /Pratinjau baca saja/);
  assert.match(markup, /Synthetic Transit Operator/);
  assert.match(markup, /Mendukung klaim fixture/);
  assert.match(markup, /reviewed_synthetic_fixture/);
  assert.doesNotMatch(markup, /<button/);
  assert.doesNotMatch(markup, /Terbitkan klaim|Simpan koreksi|Tolak klaim|Tarik versi/);
});
