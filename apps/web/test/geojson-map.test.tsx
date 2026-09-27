import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type {
  EventView,
  PublicContext,
  PublicFeature,
  PublicFeatureCollection,
  PublicGeoJSONGeometry,
} from "@waspada/worker/public-contracts";
import { SiteHeader } from "../src/App.js";
import { ApiPayloadError, getEventGeoJSON, parsePublicGeoJSON } from "../src/api-client.js";
import { DEFAULT_FEED_FILTERS, EventFeed } from "../src/EventFeed.js";
import { MapPanel, projectCRS84Position, type GeoJSONMapState } from "../src/MapPanel.js";

const liveContext: PublicContext = {
  dataset_mode: "live",
  dataset_label: "live",
  generated_at: "2026-09-27T00:00:00.000Z",
  sources: [],
};


function makeEvent(eventId: string, version = 1, title = "Event " + eventId): EventView {
  return {
    event_id: eventId,
    version,
    title,
    summary: "Public summary for " + eventId,
    category: "disasters_weather",
    tags: [],
    lifecycle: "ongoing",
    freshness: {
      status: "needs_update",
      evaluated_at: "2026-09-27T00:00:00.000Z",
      review_due_at: null,
      basis: "manual_review",
    },
    event_time: { start: null, end: null, precision: "unknown" },
    validity: { valid_from: null, valid_until: null },
    scope: { places: [], services: [], institutions: [], audiences: [] },
    claims: [],
    impacts: [],
    published_at: "2026-09-27T00:00:00.000Z",
  };
}

const geometries: PublicGeoJSONGeometry[] = [
  { type: "Point", coordinates: [106.7, -6.2] },
  { type: "MultiPoint", coordinates: [[106.71, -6.21], [106.72, -6.22]] },
  { type: "LineString", coordinates: [[106.73, -6.23], [106.74, -6.24]] },
  { type: "MultiLineString", coordinates: [[[106.75, -6.25], [106.76, -6.26]], [[106.77, -6.27], [106.78, -6.28]]] },
  { type: "Polygon", coordinates: [[[106.65, -6.15], [106.68, -6.15], [106.68, -6.18], [106.65, -6.15]]] },
  { type: "MultiPolygon", coordinates: [[[[106.6, -6.1], [106.62, -6.1], [106.62, -6.12], [106.6, -6.1]]]] },
];

function makeFeature(event: EventView, id: string, geometry: PublicGeoJSONGeometry): PublicFeature {
  return {
    type: "Feature",
    id,
    geometry,
    properties: {
      event_id: event.event_id,
      version: event.version,
      title: event.title,
      category: event.category,
      lifecycle: event.lifecycle,
      freshness: event.freshness.status,
      geometry_role: "route_segment",
    },
  };
}

function makeCollection(features: PublicFeature[]): PublicFeatureCollection {
  return { type: "FeatureCollection", features };
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/geo+json; charset=utf-8" },
  });
}

test("GeoJSON browser client uses the documented route, filters, media type, and allowlist", async (t) => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
  const event = makeEvent("geo-live");
  const feature = makeFeature(event, "geo-feature-1", geometries[0]!);
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ input, init });
    return jsonResponse({
      ...makeCollection([feature]),
      sql: "must not reach the UI",
      features: [{
        ...feature,
        properties: { ...feature.properties, private_debug: "must not reach the UI" },
        source_text: "must not reach the UI",
      }],
    });
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const result = await getEventGeoJSON({
    category: "disasters_weather",
    lifecycle: "ongoing",
    freshness: "current",
  });

  assert.equal(requests[0]?.input, "/api/v1/events.geojson?category=disasters_weather&lifecycle=ongoing&freshness=current");
  assert.equal((requests[0]?.init?.headers as Record<string, string>).accept, "application/geo+json");
  assert.deepEqual(Object.keys(result), ["type", "features"]);
  assert.deepEqual(Object.keys(result.features[0]!.properties), [
    "event_id",
    "version",
    "title",
    "category",
    "lifecycle",
    "freshness",
    "geometry_role",
  ]);
  assert.equal("source_text" in result.features[0]!, false);
});

test("GeoJSON browser client omits an empty query and rejects invalid media or oversized bodies", async (t) => {
  const originalFetch = globalThis.fetch;
  const requests: Array<RequestInfo | URL> = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    requests.push(input);
    return jsonResponse({ type: "FeatureCollection", features: [] });
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  assert.deepEqual(await getEventGeoJSON(), { type: "FeatureCollection", features: [] });
  assert.equal(requests[0], "/api/v1/events.geojson");

  globalThis.fetch = (async () => new Response("{}", {
    status: 200,
    headers: { "content-type": "application/json" },
  })) as typeof fetch;
  await assert.rejects(getEventGeoJSON(), ApiPayloadError);

  globalThis.fetch = (async () => new Response("{}", {
    status: 200,
    headers: { "content-type": "application/geo+json", "content-length": String(2 * 1024 * 1024 + 1) },
  })) as typeof fetch;
  await assert.rejects(getEventGeoJSON(), ApiPayloadError);

  globalThis.fetch = (async () => new Response(new Uint8Array(2 * 1024 * 1024 + 1), {
    status: 200,
    headers: { "content-type": "application/geo+json" },
  })) as typeof fetch;
  await assert.rejects(getEventGeoJSON(), ApiPayloadError);
});

test("GeoJSON parser accepts all six contract geometries and rejects out-of-envelope or malformed rings", () => {
  const events = geometries.map((_, index) => makeEvent("geo-" + index));
  const features = geometries.map((geometry, index) => makeFeature(events[index]!, "geometry-" + index, geometry));
  const parsed = parsePublicGeoJSON(makeCollection(features));

  assert.deepEqual(parsed.features.map((feature) => feature.geometry.type), [
    "Point",
    "MultiPoint",
    "LineString",
    "MultiLineString",
    "Polygon",
    "MultiPolygon",
  ]);
  assert.throws(() => parsePublicGeoJSON(makeCollection([
    makeFeature(events[0]!, "outside-envelope", { type: "Point", coordinates: [107.01, -6.2] }),
  ])), ApiPayloadError);
  assert.throws(() => parsePublicGeoJSON(makeCollection([
    makeFeature(events[0]!, "open-ring", {
      type: "Polygon",
      coordinates: [[[106.65, -6.15], [106.68, -6.15], [106.68, -6.18], [106.64, -6.14]]],
    }),
  ])), ApiPayloadError);
  assert.throws(() => parsePublicGeoJSON({ type: "FeatureCollection", features: new Array(501).fill(features[0]) }), ApiPayloadError);
});

test("CRS84 projection is deterministic, centered, and leaves source geometry unchanged", () => {
  const source: [number, number] = [106.7, -6.2];
  const first = projectCRS84Position(source);
  const second = projectCRS84Position(source);
  assert.deepEqual(first, second);
  assert.equal(source[0], 106.7);
  assert.equal(source[1], -6.2);
  assert.ok(first[0] > 0 && first[0] < 500);
  assert.ok(first[1] > 0 && first[1] < 500);
});

test("map renders all six geometry types as keyboard-operable linked features", () => {
  const events = geometries.map((_, index) => makeEvent("geo-" + index, 1, "Map event " + index));
  const features = geometries.map((geometry, index) => makeFeature(events[index]!, "geometry-" + index, geometry));
  const markup = renderToStaticMarkup(
    <MapPanel
      selection={{ kind: "none" }}
      mapState={{ status: "loaded", data: makeCollection(features) }}
      context={liveContext}
      feedStatus="loaded"
      visibleEvents={events}
      onSelectApiEvent={() => {}}
      onRetryMap={() => {}}
      onReturnToList={() => {}}
    />,
  );

  for (let index = 0; index < geometries.length; index += 1) {
    assert.match(markup, new RegExp('data-feature-id="geometry-' + index + '"'));
  }
  assert.match(markup, /role="button"/);
  assert.match(markup, /tabindex="0"/);
  assert.match(markup, /aria-label="Feature CRS84 yang cocok dengan daftar API dimuat"/);
  assert.match(markup, /Peta koordinat CRS84/);
  assert.match(markup, /Tanpa peta dasar/);
  assert.match(markup, /Equirektangular lokal; posisi sumber tidak diubah/);
});

test("map links only visible exact-version records and shows source coordinates plus the detail link", () => {
  const visibleEvent = makeEvent("visible-1", 1, "Visible API event");
  const hiddenEvent = makeEvent("hidden-1", 1, "Filtered API event");
  const visibleFeature = makeFeature(visibleEvent, "visible-feature", geometries[2]!);
  const hiddenFeature = makeFeature(hiddenEvent, "filtered-feature", geometries[0]!);
  const staleFeature = makeFeature(makeEvent("visible-1", 2, "Stale version"), "stale-feature", geometries[1]!);
  const markup = renderToStaticMarkup(
    <MapPanel
      selection={{ kind: "api-event", event: visibleEvent, featureId: "visible-feature" }}
      mapState={{ status: "loaded", data: makeCollection([visibleFeature, hiddenFeature, staleFeature]) }}
      context={liveContext}
      feedStatus="loaded"
      visibleEvents={[visibleEvent]}
      onSelectApiEvent={() => {}}
      onRetryMap={() => {}}
      onReturnToList={() => {}}
    />,
  );

  assert.match(markup, /data-feature-id="visible-feature"/);
  assert.doesNotMatch(markup, /data-feature-id="filtered-feature"|data-feature-id="stale-feature"/);
  assert.match(markup, /aria-pressed="true"/);
  assert.match(markup, /106\.73, -6\.23 · 106\.74, -6\.24/);
  assert.match(markup, /href="#detail\/api\/visible-1">Buka detail record API/);
});

test("filtering a previously selected event out of the loaded page hides it without claiming its geometry is missing", () => {
  const selectedEvent = makeEvent("selected-then-filtered", 1, "Filtered after selection");
  const feature = makeFeature(selectedEvent, "selected-before-filter", geometries[2]!);
  const markup = renderToStaticMarkup(
    <MapPanel
      selection={{ kind: "api-event", event: selectedEvent, featureId: feature.id }}
      mapState={{ status: "loaded", data: makeCollection([feature]) }}
      context={liveContext}
      feedStatus="loaded"
      visibleEvents={[]}
      onSelectApiEvent={() => {}}
      onRetryMap={() => {}}
      onReturnToList={() => {}}
    />,
  );

  assert.match(markup, /Tidak ada geometri yang cocok pada halaman ini/);
  assert.doesNotMatch(markup, /Tidak dipetakan: respons GeoJSON tidak menyertakan geometri/);
  assert.doesNotMatch(markup, /data-feature-id="selected-before-filter"/);
});

function renderLiveFeed(mapState: GeoJSONMapState) {
  const event = makeEvent("feed-live-1", 1, "Live event stays visible");
  return renderToStaticMarkup(
    <>
      <SiteHeader route={{ screen: "discover" }} context={liveContext} />
      <EventFeed
        status="loaded"
        events={[event]}
        context={liveContext}
        query=""
        onQueryChange={() => {}}
        filters={DEFAULT_FEED_FILTERS}
        onCategoryChange={() => {}}
        onLifecycleChange={() => {}}
        onFreshnessChange={() => {}}
        onClearFilters={() => {}}
        onRetry={() => {}}
        mapSelection={{ kind: "none" }}
        geoJSONState={mapState}
        onSelectApiEvent={() => {}}
        onSelectPresentation={() => {}}
        onRetryMap={() => {}}
        mobilePanel="list"
        onMobilePanelChange={() => {}}
      />
    </>,
  );
}

test("map failure stays independent from the feed and live mode hides the presentation fixture", () => {
  const markup = renderLiveFeed({ status: "unavailable" });
  assert.match(markup, /LIVE — record berasal dari dataset live API/);
  assert.match(markup, /Live event stays visible/);
  assert.match(markup, /Peta koordinat belum dapat dimuat/);
  assert.match(markup, /Coba lagi memuat peta/);
  assert.doesNotMatch(markup, /fixture presentasi|Bus 12 diversion|route-diagram/);
  assert.doesNotMatch(markup, /DEMO — data sintetis/);
});

test("unknown context never asserts demo or live mode", () => {
  const markup = renderToStaticMarkup(
    <SiteHeader route={{ screen: "discover" }} context={null} />,
  );
  assert.match(markup, /Status dataset tidak tersedia/);
  assert.match(markup, /Jenis dataset belum dapat diverifikasi/);
  assert.doesNotMatch(markup, /Mode demo|Mode live|DEMO —|LIVE —/);
});
