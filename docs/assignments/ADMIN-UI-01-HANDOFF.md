# ADMIN-UI-01 handoff

**Date:** 10 October 2026  
**Source commit:** `5842ffa` (`feat(admin): add read-only operations dashboard`)  
**Accessibility follow-up:** `14634e4` (keeps the smallest text action at 44px)  
**Status:** Implemented in the assigned UI slice; root owns route/style integration and browser QA.

## Delivered

`AdminDashboard` is a standalone, Bahasa Indonesia operations workspace with one focusable `<main id="main-content">`, its own public return link, and a map-forward queue/inspector layout. The local simulator and public endpoint monitor are separate modes. The simulator is explicitly fictional, unauthenticated, read-only, finite, and starts paused; its timer advances only while the page is visible. API mode uses the monitor module’s bounded public GET requests and shows the server dataset mode separately from each item’s dataset label.

Search and current-result filters link the queue and map selection. Mapped, unmapped, and unknown geometry counts apply to the loaded filtered set; an unsuccessful GeoJSON probe hides old geometry and disables the unmapped filter. The inspector separates public event lifecycle, freshness, event time precision, source validity, browser retrieval time, and the limited public L4 status. API mode preserves only explicitly observed public L1/L4/L5 summaries; internal L2/L3 metrics and activity remain unavailable. Loading, empty, failed, paused, offline, and stale-observation states explain what was or was not observed.

The dashboard stylesheet uses existing design tokens and system typography, adds narrow-screen map/list switching and stacked panels, keeps controls at least 44px high, exposes focus styling for controls, and honors reduced-motion preferences. No dependencies, external fonts, tiles, or writes were added. The component transfers focus to its main only when focus was on `body` or a detached route fallback, leaving an actual focused control alone.

## Validation performed

In WSL Ubuntu 26.04 with Node 24.21.0:

- Admin UI, map, and monitor tests: **28/28 passed** using `../../node_modules/.bin/tsx --test test/admin-dashboard.test.tsx test/admin-monitoring.test.ts test/admin-map.test.tsx` from `apps/web`.
- Web TypeScript check: **passed** using `npm --prefix apps/web run typecheck`.

The UI tests cover filtered selection and coverage, geometry-known versus unknown counts, stale/current-attempt identity even when timestamps collide, loading-time snapshot isolation, separate public status/time semantics, permitted observed-layer summaries, and the single main focus target.

## Remaining integration checks

The root integration branch owns `App` routing, lazy/Suspense integration, stylesheet imports, test scripts, and the full build. Browser screenshots, 320px/200% zoom, keyboard-only traversal, screen-reader behavior, and live same-origin endpoint behavior were not manually tested in this slice; the root integration QA should record those separately. The public API mode is observational only and does not expose private server health, queues, model usage, audit traces, or moderator controls.
