import assert from "node:assert/strict";
import test from "node:test";
import { coordinateAt, easeInOutCubic, flyPath, viewWithFocusOffset, worldAt, zoomAround, type MapView } from "../src/map-motion.js";
import { placeTiles, tileZoomFor } from "../src/EventMapCanvas.js";

/** MAP-UX-02: continuous zoom, anchored zoom, the event fly path and seamless scaled tiles. */

const JAKARTA: MapView = { center: [106.8456, -6.2088], zoom: 12 };
const close = (a: number, b: number, tolerance = 1e-6) => Math.abs(a - b) <= tolerance;

test("world pixels and coordinates round-trip at a fractional zoom", () => {
  const point = worldAt(JAKARTA.center, 12.4);
  const [longitude, latitude] = coordinateAt(point.x, point.y, 12.4);
  assert.ok(close(longitude, JAKARTA.center[0]) && close(latitude, JAKARTA.center[1]));
});

test("zooming around a point keeps the map point under it in place", () => {
  const anchor = { x: 700, y: 200 };
  const width = 1000;
  const height = 600;
  const before = worldAt(JAKARTA.center, JAKARTA.zoom);
  const underAnchor = coordinateAt(before.x + anchor.x - width / 2, before.y + anchor.y - height / 2, JAKARTA.zoom);
  const next = zoomAround(JAKARTA, 13.7, anchor, width, height);
  const center = worldAt(next.center, next.zoom);
  const point = worldAt(underAnchor, next.zoom);
  assert.equal(next.zoom, 13.7);
  assert.ok(close(point.x - center.x + width / 2, anchor.x, 1e-3));
  assert.ok(close(point.y - center.y + height / 2, anchor.y, 1e-3));
});

test("a focus offset puts the target that many pixels right of and below the centre", () => {
  const focus = [106.79, -6.24] as const;
  const view = viewWithFocusOffset(focus, 15, 180, 120);
  const center = worldAt(view.center, 15);
  const target = worldAt(focus, 15);
  assert.ok(close(target.x - center.x, 180, 1e-3));
  assert.ok(close(target.y - center.y, 120, 1e-3));
});

test("the fly path starts and ends exactly on its views and stays finite in between", () => {
  const to: MapView = { center: [106.9, -6.3], zoom: 15 };
  const path = flyPath(JAKARTA, to, 900);
  assert.equal(path.at(0), JAKARTA);
  assert.equal(path.at(1), to);
  for (let t = 0.1; t < 1; t += 0.1) {
    const view = path.at(t);
    assert.ok(Number.isFinite(view.zoom) && Number.isFinite(view.center[0]) && Number.isFinite(view.center[1]));
  }
  assert.ok(path.duration >= 280 && path.duration <= 1400);
});

test("between two distant events at the same zoom the camera zooms out mid-flight, then back in", () => {
  const from: MapView = { center: [106.75, -6.15], zoom: 15 };
  const to: MapView = { center: [106.95, -6.35], zoom: 15 };
  const path = flyPath(from, to, 900);
  const middle = path.at(0.5);
  assert.ok(middle.zoom < 14, `mid-flight zoom ${middle.zoom}`);
  assert.ok(path.duration > 600, "a long trip takes visibly longer than a short one");
});

test("a pure zoom keeps the centre and changes zoom monotonically", () => {
  const path = flyPath(JAKARTA, { center: JAKARTA.center, zoom: 13 }, 900);
  let previous = JAKARTA.zoom;
  for (let t = 0.1; t <= 1; t += 0.1) {
    const view = path.at(Math.min(1, t));
    assert.ok(view.zoom >= previous - 1e-9);
    assert.ok(close(view.center[0], JAKARTA.center[0], 1e-6));
    previous = view.zoom;
  }
});

test("the easing curve runs from 0 to 1 and is symmetric", () => {
  assert.equal(easeInOutCubic(0), 0);
  assert.equal(easeInOutCubic(1), 1);
  assert.ok(close(easeInOutCubic(0.5), 0.5));
  assert.ok(close(easeInOutCubic(0.25) + easeInOutCubic(0.75), 1));
});

test("scaled tiles at a fractional zoom cover the view edge to edge with no seams", () => {
  const view: MapView = { center: JAKARTA.center, zoom: 12.4 };
  const width = 900;
  const height = 600;
  const tiles = placeTiles(view, width, height, tileZoomFor(view.zoom));
  assert.equal(tileZoomFor(12.4), 12);
  assert.ok(tiles.length > 0);
  const columns = [...new Set(tiles.map((tile) => tile.left))].sort((a, b) => a - b);
  for (const tile of tiles) {
    assert.ok(Number.isInteger(tile.left) && Number.isInteger(tile.top) && Number.isInteger(tile.width));
    const next = tiles.find((other) => other.top === tile.top && other.left > tile.left && other.left - tile.left < tile.width + 2);
    if (next) assert.equal(next.left, tile.left + tile.width, "neighbours share an edge exactly");
  }
  assert.ok(columns[0]! <= 0, "the first column starts at or before the left edge");
  const rightmost = Math.max(...tiles.map((tile) => tile.left + tile.width));
  const bottommost = Math.max(...tiles.map((tile) => tile.top + tile.height));
  assert.ok(rightmost >= width && bottommost >= height, "tiles reach the right and bottom edges");
});
