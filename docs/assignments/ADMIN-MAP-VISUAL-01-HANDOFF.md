# ADMIN-MAP-VISUAL-01 handoff

**Date:** 10 October 2026. **Branch:** `work/ADMIN-MAP-VISUAL-01`. **Assigned base:** `36da86a`. **Implementation:** `6b443bd`.

## Delivered

`AdminOperationsMap(props: AdminMapProps)` provides a labelled geographic CRS84 coordinate canvas, exact point/segment/polygon rendering, linked record selection, visible camera controls, keyboard selection and camera navigation, coordinate extents, legends, and empty/unmapped explanations. Source and selected geometry are never buffered, rewritten or mutated. Primary and `additionalGeometries` remain under the same record selection; malformed geometry fails closed for the whole record rather than silently losing a part. Polygon holes use even-odd fill. All six variants supported by the public contract are covered.

The initial camera uses the permitted mainland view only. Fit-all covers the complete loaded geometry extent, including northern island coordinates; focus-selection can restore an offscreen selection. The application query envelope validates incoming coordinates defensively but is never drawn. There are no roads, coastlines, municipal polygons, tiles, location requests, external fonts, dependencies, network calls or API changes.

Simulation uses explicitly synthetic geometry and separate L1–L5 stage and processing-state glyphs. API mode requires `source_supported` basis plus an exact public event ID/version, including explicitly labelled synthetic records returned by an actual demo API. It never draws `synthetic_example` simulator shapes. API glyphs say `PUB`, the selection says “Proyeksi event publik · Record tersedia”, and the legend explains that internal stage and processing status are unavailable. Dataset kinds and synthetic notices remain visible. Color does not encode incident severity.

Map controls and marker cards retain at least 44px targets. Resize-aware SVG projection keeps marker targets at screen size and reserves extra coordinate-label space for enlarged text. Selection focus is visible; motion is static and reduced-motion remains supported.

## Checks actually run

All commands ran locally; Node tests/typecheck/bundle used WSL Ubuntu-26.04 and Node 24.21.0.

- From `apps/web`: `node ../../node_modules/tsx/dist/cli.mjs --test test/admin-map.test.tsx` — **10/10 passed**. Covers projection orientation/aspect/inverse at wide, narrow and enlarged-text sizes; six geometry variants and holes; extra geometry grouping; malformed/nonfinite/out-of-envelope shapes; simulation/API separation and synthetic API regression; source immutability; island fit; bounded camera transforms; selection/provenance and honest empty/unmapped/stale selection.
- `node node_modules/typescript/bin/tsc --noEmit -p apps/web/tsconfig.json` — **passed**.
- Standalone esbuild component and browser preview bundles — **passed**. React remained external for the isolated component size measurement.
- Headless installed Chromium through bundled Playwright — **passed**: keyboard zoom, pan, reset, Enter/Space record selection; queue-like selection of an island outside the initial frame; fit-all and focus-selection; 44px controls/cards; 320px layout and 200% root text with a long title; reduced-motion; empty API mode; zero page errors and zero HTTP/HTTPS requests. Desktop/mobile/large-text screenshots were captured and visually inspected. Enlarged-text coordinate padding was adjusted after inspection and checks rerun.
- Staged `git diff --check` — **passed**. Only the three owned source/test files were included in implementation.

Local untracked QA harness/results/screenshots live outside the repository at `C:/Users/perry/AppData/Local/Temp/admin-map-visual-qa/`. They are independent component evidence, not integrated dashboard screenshots.

## Size and integration

Added source: TSX **29,755 bytes**, CSS **11,567 bytes**, tests **15,396 bytes**. Isolated minified component ESM with React external: **20,255 bytes / 7,220 gzip**. CSS source: **11,567 bytes / 2,608 gzip**. The combined isolated addition is **31,822 bytes / 9,828 gzip**; this is not a measured production-chunk delta because integration/tree-shaking/minification can differ. No dependency or asset payload was added.

Root imports `admin-map.css` in the style entry and registers the new test with the web test script; neither shared path was changed here. The shared type prerequisite was cherry-picked separately as `2243212` from root `65f6c5e`, and does not need to be cherry-picked back. Component selection is controlled by the parent; only the current `items` subset can show a selected record. No data adapter, polling, simulator, routing or inspector implementation is owned by this slice.

## Limits

No approved basemap or administrative-boundary dataset exists. This coordinate canvas does not establish geographic completeness, factual source support, location precision, incident lifecycle or safety. Bounds/fit padding belong to the camera only. The “in frame” count uses geometry bounds intersecting the current camera and counts records, not every geometry part. Dense coincident geometries can overlap; the linked queue remains the complete selection alternative. Integrated dashboard build, actual polling smoke, browser screenshots and end-to-end parent selection/filter behavior belong to root QA. No full repository suite, hosted run, native build, push or deployment was performed by this slice.
