import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { PublicGeometry } from "@waspada/worker/public-contracts";
import {
  layoutRecordMap,
  RECORD_MAP_FIT_PADDING_PX,
  RECORD_MAP_MIN_ZOOM,
  RECORD_MAP_VIEW,
  RECORD_MAP_ZOOM,
  RecordMapPanel,
  type RecordMapLayout,
} from "../src/MapPanel.js";
import { coordinateToWorldPixels, getVisibleMapTiles } from "../src/SourcePointMap.js";

const POINT: [number, number] = [106.845, -6.185];
const TILE_PX = 256;
const ENVELOPE_CENTRE: [number, number] = [106.65, -5.78];

function geometry(id: string, value: PublicGeometry["geometry"]): PublicGeometry {
  return { geometry_id: id, role: "incident_scene", geometry: value, precision_m: 50, label: "Lokasi" } as PublicGeometry;
}

function render(geometries: PublicGeometry[] | undefined, locationDisplay?: "point" | "whole_view"): string {
  return renderToStaticMarkup(
    <RecordMapPanel
      title="Genangan uji"
      geometries={geometries}
      locationDisplay={locationDisplay}
      onReturnToList={() => {}}
    />,
  );
}

/** Every position the layout projects must sit inside the padded view. */
function assertInsidePaddedView(layout: RecordMapLayout, positions: ReadonlyArray<[number, number]>): void {
  for (const position of positions) {
    const [x, y] = layout.project(position);
    assert.ok(x >= RECORD_MAP_FIT_PADDING_PX - 1e-6 && x <= layout.width - RECORD_MAP_FIT_PADDING_PX + 1e-6, `x ${x} is on the canvas`);
    assert.ok(y >= RECORD_MAP_FIT_PADDING_PX - 1e-6 && y <= layout.height - RECORD_MAP_FIT_PADDING_PX + 1e-6, `y ${y} is on the canvas`);
  }
}

test("the record pin sits at its Web Mercator pixel minus the tile origin, centred on the point", () => {
  const layout = layoutRecordMap({ points: [POINT], positions: [POINT] });
  const world = coordinateToWorldPixels(POINT, RECORD_MAP_ZOOM);
  assert.equal(layout.zoom, RECORD_MAP_ZOOM, "a single point is shown at the highest zoom");
  assert.ok(layout.pin);
  assert.ok(Math.abs(layout.pin.x - (world.x - layout.origin.x)) < 1e-9);
  assert.ok(Math.abs(layout.pin.y - (world.y - layout.origin.y)) < 1e-9);
  assert.ok(Math.abs(layout.pin.x - RECORD_MAP_VIEW.width / 2) < 1e-6, "the view is centred on the point");
  assert.ok(Math.abs(layout.pin.y - RECORD_MAP_VIEW.height / 2) < 1e-6);
});

test("the tile under the pin is the one getVisibleMapTiles reports for that pixel", () => {
  const layout = layoutRecordMap({ points: [POINT], positions: [POINT] });
  const world = coordinateToWorldPixels(POINT, layout.zoom);
  const tileX = Math.floor(world.x / TILE_PX);
  const tileY = Math.floor(world.y / TILE_PX);
  const tile = layout.tiles.find((candidate) => candidate.x === tileX && candidate.y === tileY);
  assert.ok(tile, "the tile containing the pin is drawn");
  assert.ok(layout.pin);
  assert.ok(layout.pin.x >= tile.left && layout.pin.x < tile.left + TILE_PX);
  assert.ok(layout.pin.y >= tile.top && layout.pin.y < tile.top + TILE_PX);
  assert.deepEqual(layout.tiles, getVisibleMapTiles(RECORD_MAP_VIEW.width, RECORD_MAP_VIEW.height, layout.center, layout.zoom));
  for (const candidate of layout.tiles) {
    assert.ok(Math.abs(candidate.left - (candidate.x * TILE_PX - layout.origin.x)) < 1e-9, "tiles sit at their Web Mercator offsets");
    assert.ok(Math.abs(candidate.top - (candidate.y * TILE_PX - layout.origin.y)) < 1e-9);
  }
});

test("a record with nothing drawable gets no pin and is centred on the envelope centre", () => {
  const layout = layoutRecordMap({ points: [], positions: [] });
  assert.equal(layout.pin, null);
  assert.equal(layout.zoom, RECORD_MAP_ZOOM);
  assert.ok(Math.abs(layout.center[0] - ENVELOPE_CENTRE[0]) < 1e-9);
  assert.ok(Math.abs(layout.center[1] - ENVELOPE_CENTRE[1]) < 1e-9);
});

test("a LineString-only record is fitted and stays on the canvas, with no pin", () => {
  // 0.5 deg of longitude does not fit at zoom 11 (448 px inside the padding) but does at zoom 10.
  const line: Array<[number, number]> = [[106.45, -6.3], [106.95, -6.0]];
  const layout = layoutRecordMap({ points: [], positions: line });
  assert.equal(layout.pin, null, "a line never gives a pin");
  assert.equal(layout.zoom, 10);
  assertInsidePaddedView(layout, line);

  const markup = render([geometry("g-line", { type: "LineString", coordinates: line })]);
  assert.match(markup, /class="geo-feature__line"/u, "the line is drawn");
  assert.doesNotMatch(markup, /geo-feature__point|geo-feature__pin-group/u);
  assert.match(markup, /record-map__attribution/u);
});

test("a very spread record falls back to the minimum zoom instead of a closer one", () => {
  const spread: Array<[number, number]> = [[106.35, -6.38], [106.95, -5.2]];
  const layout = layoutRecordMap({ points: [], positions: spread });
  assert.equal(layout.zoom, RECORD_MAP_MIN_ZOOM);
});

test("several points are centred on the midpoint of their bounds, both on the canvas", () => {
  const first: [number, number] = [106.8, -6.25];
  const second: [number, number] = [106.9, -6.1];
  const layout = layoutRecordMap({ points: [first, second], positions: [first, second] });
  const a = layout.project(first);
  const b = layout.project(second);
  assert.ok(Math.abs((a[0] + b[0]) / 2 - RECORD_MAP_VIEW.width / 2) < 1e-6, "the bounds are centred horizontally");
  assert.ok(Math.abs((a[1] + b[1]) / 2 - RECORD_MAP_VIEW.height / 2) < 1e-6, "the bounds are centred vertically");
  assertInsidePaddedView(layout, [first, second]);
  assert.ok(layout.pin, "the first point is the pin");
  assert.ok(Math.abs(layout.pin.x - a[0]) < 1e-9 && Math.abs(layout.pin.y - a[1]) < 1e-9);
});

test("a point decides the view over lines and polygons", () => {
  const polygonRing: Array<[number, number]> = [[106.36, -6.36], [106.4, -6.36], [106.4, -6.33], [106.36, -6.36]];
  const layout = layoutRecordMap({ points: [POINT], positions: [...polygonRing, POINT] });
  assert.equal(layout.zoom, RECORD_MAP_ZOOM);
  assert.ok(layout.pin);
  assert.ok(Math.abs(layout.pin.x - RECORD_MAP_VIEW.width / 2) < 1e-6, "the view centres on the point, not the polygon");
  assert.ok(Math.abs(layout.pin.y - RECORD_MAP_VIEW.height / 2) < 1e-6);
});

test("a mapped point renders its tiles, its pin and the OpenStreetMap attribution, with no fixture chip", () => {
  const markup = render([geometry("g-1", { type: "Point", coordinates: POINT })]);
  const layout = layoutRecordMap({ points: [POINT], positions: [POINT] });
  assert.ok(layout.pin);

  const pinMatch = markup.match(/<circle class="geo-feature__point" cx="([^"]+)" cy="([^"]+)"/u);
  assert.ok(pinMatch, "the point is drawn as the pin");
  assert.ok(Math.abs(Number(pinMatch[1]) - layout.pin.x) < 1e-6);
  assert.ok(Math.abs(Number(pinMatch[2]) - layout.pin.y) < 1e-6);

  const tileImages = [...markup.matchAll(/<img class="record-map__tile" src="([^"]+)" alt="" width="256" height="256"[^>]*style="left:([-\d.e]+)%;top:([-\d.e]+)%;/gu)];
  assert.equal(tileImages.length, layout.tiles.length, "every tile from the layout is drawn");
  for (const [, src, leftPercent, topPercent] of tileImages) {
    const tile = layout.tiles.find((candidate) => src === `https://tile.openstreetmap.org/${layout.zoom}/${candidate.x}/${candidate.y}.png`);
    assert.ok(tile, "the drawn tile is the one the layout reports");
    assert.ok(Math.abs(Number(leftPercent) / 100 * RECORD_MAP_VIEW.width - tile.left) < 1e-4);
    assert.ok(Math.abs(Number(topPercent) / 100 * RECORD_MAP_VIEW.height - tile.top) < 1e-4);
  }

  assert.match(markup, /<a class="record-map__attribution" href="https:\/\/www\.openstreetmap\.org\/copyright" target="_blank" rel="noreferrer">© OpenStreetMap contributors<\/a>/u);
  assert.doesNotMatch(markup, /Tanpa peta dasar/u, "the chip goes once tiles are drawn");
});

test("a polygon-only record draws its tiles and polygon but invents no pin", () => {
  const polygon = geometry("g-2", {
    type: "Polygon",
    coordinates: [[[106.82, -6.2], [106.83, -6.2], [106.83, -6.19], [106.82, -6.2]]],
  });
  const markup = render([polygon]);
  assert.match(markup, /class="geo-feature__polygon"/u);
  assert.doesNotMatch(markup, /geo-feature__point|geo-feature__pin-group/u, "no pin without a point");
  assert.match(markup, /record-map__attribution/u);
  assert.doesNotMatch(markup, /Tanpa peta dasar/u);
});

test("without drawable geometry there are no tiles, and the no-basemap chip stays", () => {
  for (const html of [render(undefined), render([]), render([], "whole_view")]) {
    assert.match(html, /Tanpa peta dasar/u);
    assert.doesNotMatch(html, /record-map__tile|record-map__attribution/u);
  }
});
