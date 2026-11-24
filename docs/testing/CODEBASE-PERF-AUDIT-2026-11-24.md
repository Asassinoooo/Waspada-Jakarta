# Codebase & Performance Gap Audit (24 Nov 2026)

**Audit date:** 24 Nov 2026  
**Codebase baseline audited:** `cffeab0` (`main`), reconciled against `df7c090` (`PERF-07` `0deb9d1` and `PERF-08` `65075a5` already merged on `main`).  
**Scope:** `apps/worker`, `apps/db`, `apps/intelligence`, `apps/web`, `apps/mobile`, `tools/`, and `.github/workflows/`, aligned against [PROJECT_PLAN.md](../../PROJECT_PLAN.md), [SOFTWARE_DEVELOPMENT_PLAN.md](../../SOFTWARE_DEVELOPMENT_PLAN.md), [AGENT_WORKLOG.md](../AGENT_WORKLOG.md), [IMPLEMENTATION_BACKLOG.md](../IMPLEMENTATION_BACKLOG.md), and [DEFECTS.md](DEFECTS.md).  
**Method:** Static source audit only (no local full test/build runs, no live requests, no external quota spent). Runtime items not re-measured on production are marked **not verified**.

---

## 1. Project Plan Boundaries & Constraints

Every follow-up fix must preserve the plan's hard constraints:

- **NFR-04 latency targets (owner decisions 19 & 23 Nov 2026):** Public reads `p50 < 500 ms`, `p95 < 1,000 ms`, staleness tolerance **<= 60 s** on published lists, with immediate invalidation on moderator publish, withdraw, or correction.
- **Zero-spend / Free Tier hard ceilings ([ADR-010](../decisions/ADR-010-cloudflare-neon-free.md)):**
  - **Cloudflare Workers Free:** 100,000 requests/day, **10 ms active CPU/request**, 128 MB RAM, **1,000 KV writes/day** and **100,000 KV reads/day**, Hyperdrive **100,000 SQL statements/day**.
  - **Neon Free:** **100 CU-hours/month** (auto-suspend after 5 min idle), **0.5 GB storage**, 5 GB transfer/month.
- **Mandatory product invariants:** Never state an area is safe; public views expose published versions only; map points only (never draw invented points or radii); separate event/publish/retrieval/processing timestamps; device-local user interests; L1–L5 layer separation and `DATASET_MODE` isolation.
- **Explicitly excluded (owner-accepted course limitations, not treated as gaps here):** Hosted `AUTO_PUBLISH_SOURCE_PERMISSION=local_relaxed` ([ADR-065](../decisions/ADR-065-hosted-topology.md)), local-only notifications without Web Push/Firebase, point-only map geometry, `*.workers.dev` domain, no 30-day off-provider backup/PITR, live path bypassing Worker L2/L3, and HTTP 404 on withdrawn events.
- **Already addressed on `df7c090` (between audit start and PR):**
  - `PERF-07` (`0deb9d1`): Web event list now loads `?limit=100` in one initial request with `<link rel="preload">` in `apps/web/index.html`.
  - `PERF-08` (`65075a5`): Snapshot-served 200/304 responses emit `Server-Timing` (`snap`, `kv`, `db`, `build`, `total`), and CI deploy runs `tools/perf/latency-probe.ts`.

---

## 2. P0 — Critical Findings (Cold Latency Root Cause, Free-Tier Quota Risks & Live Bugs)

### P0.1 — Root Cause of 1+ s Cold/Idle Latency & KV Free Quota Storm (`PERF-06` + `PERF-05`)

1. **Cold isolates always block synchronously on Neon because `verifiedAt` is never persisted to KV:**
   - In [apps/worker/src/runtime/public-snapshot.ts](../../apps/worker/src/runtime/public-snapshot.ts) (`checkNow` / `loadFromKv`), a matching fingerprint check only updates in-memory `memo.verifiedAt` and does not update KV. Because scheduled ingest runs every 30 minutes, `now() - snapshot.built_at > 60_000 ms` holds ~97% of the time. Whenever a cold isolate reads KV, `age > hardStaleAfterMs` (60 s) immediately triggers a synchronous `FRESH_HYPERDRIVE` query that wakes Neon from suspend before responding. This explains the 1,073–1,438 ms first-request spikes in [AGENT_WORKLOG.md](../AGENT_WORKLOG.md).
2. **Fingerprint query full-scans 7 `security_barrier` views:**
   - `PUBLIC_SNAPSHOT_FINGERPRINT_SQL` in [apps/worker/src/runtime/public-snapshot.ts](../../apps/worker/src/runtime/public-snapshot.ts) unions 7 views and computes `md5(view_row::text)` + `ORDER BY` across every row. Because `public_event_impacts`, `public_event_geometries`, and `public_event_geojson_candidates` select from `public_event_versions`, `public_event_versions` is evaluated **4 times** per fingerprint check, alongside full `DISTINCT ON` sorts on review decision tables.
3. **Multi-PoP KV write & read quota exhaustion risk:**
   - Because `ingest.yml` writes directly to Neon without pushing to KV ([tools/serve-live-pipeline.ts](../../tools/serve-live-pipeline.ts)), after every 30-min ingest cycle (48/day) **every active isolate across Cloudflare edge PoPs** independently sees the new fingerprint, rebuilds the snapshot, and calls `kv.put`. ~21 active isolates x 48 cycles exceeds the **1,000 KV writes/day** Free Tier ceiling.
   - Without `caches.default`, each isolate re-reads and re-parses KV every 15 s (`DEFAULT_MEMO_TTL_MS = 15_000`) = up to 5,760 KV reads/isolate/day (~18 active isolates saturate **100,000 KV reads/day**).

### P0.2 — Neon Free Compute-Hour Ceiling Risk (100 CU-hours/month)

1. **48x/day ingest cadence approaches or exceeds 100 CU-hours/month alone:**
   - Cron `7,37 * * * *` ([apps/worker/wrangler.toml](../../apps/worker/wrangler.toml)) runs 48 times/day; at 8–16 min/run plus Neon's 5-min auto-suspend tail, active time is 13–21 min/run = **312–504 active hours/month** (~78–126 CU-hours/month even at 0.25 CU minimum, before autoscaling or user reads).
   - [tools/serve-live-pipeline.ts](../../tools/serve-live-pipeline.ts) holds the Neon session open while polling 16 external feeds sequentially and waiting on rate-limited LLM calls, and runs `062_nfr07_retention_purge` plus two legacy full-table backfills (`backfillSourceAttributions`, `backfillPublishedLocations`) **48 times/day** (retention only needs <= 24 h cadence).
2. **Every anonymous page load opens a `pg.Client` via `AUTH_HYPERDRIVE`:**
   - [apps/worker/src/runtime/account-runtime.ts](../../apps/worker/src/runtime/account-runtime.ts) (`withAccountStore`) connects and disconnects a Postgres client **before** `createAccountApi` checks whether a session cookie or bearer token exists. Meanwhile `SiteHeader` ([apps/web/src/AppShell.tsx](../../apps/web/src/AppShell.tsx)) fetches `GET /api/v1/auth/session` on mount and on every hash navigation—waking/touching Neon for 0 SQL queries on every anonymous visitor.

### P0.3 — Workers Free 10 ms CPU Limit (Error 1102) & Cross-Request I/O Hazards

1. **200,000 PBKDF2 iterations in one request & inside a Postgres row lock:**
   - [apps/worker/src/accounts/api.ts](../../apps/worker/src/accounts/api.ts) runs two sequential 100k-iteration PBKDF2-SHA256 derivations (200k total) in `handlePasswordChange`, `handlePasswordReset`, and cold unknown-user `handleLogin` (100k already measured 25–38 ms CPU in [ADR-060](../decisions/ADR-060-password-accounts.md)).
   - [apps/db/src/accounts.ts](../../apps/db/src/accounts.ts) (`consumePasswordResetCode`) executes `verifyCode` and `hashNewPassword` while holding `FOR UPDATE OF r` and an open DB transaction.
2. **Cross-request Promise/I/O state under `no_handle_cross_request_promise_resolution` ([apps/worker/wrangler.toml](../../apps/worker/wrangler.toml)):**
   - Module-level `queue: Promise` in [apps/worker/src/runtime/public-snapshot.ts](../../apps/worker/src/runtime/public-snapshot.ts); module-level `publicSnapshotStore` capturing the first request's `env` in [apps/worker/src/index.ts](../../apps/worker/src/index.ts); cross-request `WritableStreamDefaultWriter` broadcasts + `setInterval` in [apps/worker/src/layers/l4-application-integration/event-broadcaster.ts](../../apps/worker/src/layers/l4-application-integration/event-broadcaster.ts); shared `dummyHashPromise` (caching rejections permanently) in [apps/worker/src/accounts/api.ts](../../apps/worker/src/accounts/api.ts).
3. **Unbounded vector parsing CPU spike:**
   - [apps/worker/src/runtime/embedding-visualization-handler.ts](../../apps/worker/src/runtime/embedding-visualization-handler.ts) allows `limit=500` x 768 floats (384,000 floats parsed via `.split(",")` + `Number.parseFloat` and stringified into ~4–5 MB JSON), risking Error 1102.

### P0.4 — Critical Functional, Security & Isolation Bugs

| # | Area | Files | Finding |
| --- | --- | --- | --- |
| 1 | **Android Map broken against prod Worker** | [apps/mobile/lib/src/public_api.dart](../../apps/mobile/lib/src/public_api.dart) vs [apps/worker/src/runtime/public-snapshot-route.ts](../../apps/worker/src/runtime/public-snapshot-route.ts) | `HttpPublicApi._get` rejects any `content-type != application/json`, while the Worker returns `application/geo+json` on `/api/v1/events.geojson`. `getEventMap()` is not covered in `public_api_test.dart`. |
| 2 | **Moderator publish/reject parameters dropped** | [apps/worker/src/index.ts](../../apps/worker/src/index.ts) vs [apps/worker/src/layers/l4-application-integration/moderation-api.ts](../../apps/worker/src/layers/l4-application-integration/moderation-api.ts) | `moderation-api.ts` validates `reason`, `evidence_label`, `category_resolution`, and `resolved_category`, but `index.ts` discards all of them when invoking `decideProposal` and `rejectProposal`. |
| 3 | **Admin dashboard rejects valid live events** | [apps/web/src/admin-monitoring.ts](../../apps/web/src/admin-monitoring.ts), [apps/web/src/api-client.ts](../../apps/web/src/api-client.ts), [apps/web/src/UpdatesCenter.tsx](../../apps/web/src/UpdatesCenter.tsx) | `admin-monitoring.ts` uses strict `hasExactKeys` omitting optional contract fields (`incident_type`, `location_display`, `location_label`, `severity`) and categories `other`/`unclassified` (the two categories are also missing in `api-client.ts` and `UpdatesCenter.tsx`). |
| 4 | **Live dataset isolation leak** | [apps/worker/src/runtime/embedding-visualization-handler.ts](../../apps/worker/src/runtime/embedding-visualization-handler.ts) | In `DATASET_MODE=live`, DB errors or 0 rows return HTTP 200 with hardcoded synthetic data (`datasetKind: "synthetic"`). |
| 5 | **Webhook auto-approves arbitrary sources** | [apps/worker/src/index.ts](../../apps/worker/src/index.ts), [apps/worker/src/layers/l1-data-knowledge/webhook-ingest.ts](../../apps/worker/src/layers/l1-data-knowledge/webhook-ingest.ts) | Any holder of `WEBHOOK_SERVICE_KEY` inserts arbitrary `source_id` rows into `source_registry` with `approval_status = 'approved'`, with no request body byte cap or batch-size limit. |
| 6 | **Pre-throttle DB write DoS & error leak** | [apps/worker/src/accounts/api.ts](../../apps/worker/src/accounts/api.ts), [apps/worker/src/layers/l4-application-integration/moderation-api.ts](../../apps/worker/src/layers/l4-application-integration/moderation-api.ts) | Auth routes execute 3-table `DELETE` (`cleanupExpired`) **before** throttle checks; publish failures return raw `err.message` in HTTP 500; moderation `request.text()` has no size limit; unguarded `decodeURIComponent` turns malformed URLs into HTTP 503. |

---

## 3. P1 — High-Impact Performance Gaps by Layer

### 3.1 Worker API & Database (`apps/worker`, `apps/db`)

1. **F-25 `DISTINCT ON` slow query pattern remains in two public views:**
   - [apps/db/migrations/061_public_event_updates_automatic.sql](../../apps/db/migrations/061_public_event_updates_automatic.sql) (`public_event_updates_candidates`) and [apps/db/migrations/060_public_source_attribution_retrieved_at.sql](../../apps/db/migrations/060_public_source_attribution_retrieved_at.sql) (`public_source_attributions`) still place `SELECT DISTINCT ON` inside `security_barrier` views, blocking outer predicate pushdown (`change_sequence > $1` / `evidence_ref_id = ANY($1)`).
   - `GET /api/v1/updates` ([apps/worker/src/runtime/public-event-updates-runtime.ts](../../apps/worker/src/runtime/public-event-updates-runtime.ts)) also lacks caching, imports the HMAC `CryptoKey` on every request, and decodes the cursor twice.
2. **Filtered reads bypass KV snapshot & PostGIS GiST index:**
   - Any query param on `/api/v1/events` or `/api/v1/events.geojson` bypasses `PUBLIC_SNAPSHOT` ([apps/worker/src/runtime/public-snapshot-route.ts](../../apps/worker/src/runtime/public-snapshot-route.ts)) even though all events and GeoJSON features are already in the snapshot.
   - `public_event_geojson_candidates` ([apps/db/migrations/020_public_event_freshness_aggregate.sql](../../apps/db/migrations/020_public_event_freshness_aggregate.sql)) prevents outer PostGIS `&&`/`ST_Intersects` pushdown across `security_barrier` (non-`LEAKPROOF`).
   - [apps/db/src/public-event-list.ts](../../apps/db/src/public-event-list.ts) evaluates `public_event_versions` twice (joining `public_event_history_versions` for `version = 1`), transmits `record_json` twice per row, and sorts by `first_published_at::timestamptz DESC` without an index.
3. **Write-on-every-read & row lock contention on authenticated GETs:**
   - [apps/db/src/accounts.ts](../../apps/db/src/accounts.ts) (`readSession`) acquires `FOR UPDATE OF s, a` and updates `last_seen_at` on every authenticated GET, serializing concurrent SPA requests from the same operator and waking Neon.
4. **Excessive sequential `pg.Client` connections & redundant work:**
   - `POST /api/v1/moderation/proposals/:id/publish` opens **7+ sequential connections** (calling `fetchProposalDetail` 3 times and opening 1 new client per claim `source_id` in [apps/worker/src/layers/l4-application-integration/proposal-publication.ts](../../apps/worker/src/layers/l4-application-integration/proposal-publication.ts)).
   - `buildPublicSnapshotDraft` opens 2 separate connections (non-atomic with fingerprint) and reads all published events 3 times (list, detail batches, GeoJSON).
   - [apps/worker/src/index.ts](../../apps/worker/src/index.ts) initializes DB runtimes and cursor codecs *before* checking the KV snapshot fast path; `answerFromSnapshot` runs `JSON.stringify` before checking `If-None-Match` (304).
   - [apps/db/src/pipeline-flow-store.ts](../../apps/db/src/pipeline-flow-store.ts) runs 13–16 sequential queries without matching time/status indexes; `readPendingProposals` ([apps/db/src/event-proposal-writer.ts](../../apps/db/src/event-proposal-writer.ts)) has no `LIMIT`; `GET /api/v1/context` is static but sends `cache-control: no-store`.
5. **Worker cold-start bundle bloat:**
   - [apps/worker/src/index.ts](../../apps/worker/src/index.ts) statically imports `osm-reference-snapshot.json` (76 KB—validated on every cold start even when `SOURCE_PREVIEW_ENABLED="false"`), `jakarta-gazetteer.json` (247 KB), `incident-lexicon.json` (47 KB), `saxes`, and in-Worker pollers unused under `SCHEDULED_MODE="github_dispatch"`.
6. **Missing DB indexes, storage bloat (0.5 GB Neon cap), and non-atomic job claim:**
   - Missing indexes on `embedding_runs(dataset_kind, chunk_id)`, `embedding_vectors` (no HNSW/IVFFlat ANN index), `publication_decisions(dataset_kind, proposal_id)`, `event_proposals(dataset_kind, proposed_at DESC)`, `incident_correlation_decisions(dataset_kind, target_incident_id)`, and cleanup predicates on `account_sessions`, `password_reset_codes`, and `report_revisions(retrieved_at)`.
   - Operational tables with no scheduled pruning: `ai_jobs`, `acquisition_jobs`, `traces`, `pipeline_cycle_runs`, `news_triage_attempts`, `publication_outbox*`, `password_reset_codes`, `account_sessions`.
   - `claimAiJob` ([apps/db/src/incident-repository.ts](../../apps/db/src/incident-repository.ts)) splits `SELECT ... FOR UPDATE SKIP LOCKED` and `UPDATE` outside a transaction (TOCTOU race under concurrent workers).

### 3.2 Ingest & AI Pipeline (`apps/intelligence`, `tools/`)

1. **Doubled interpretation prompt tokens:** [apps/intelligence/src/agents/report-interpretation-agent.ts](../../apps/intelligence/src/agents/report-interpretation-agent.ts) embeds both full `=== REPORT TEXT ===` and all `=== EVIDENCE CHUNKS ===` (slices of the same text), halving the NFR-02 8,000-token input budget.
2. **Sequential feed polling & serialized embeddings:** [tools/serve-live-pipeline.ts](../../tools/serve-live-pipeline.ts) polls 16 feeds sequentially while holding Neon open and writes `ON CONFLICT DO UPDATE` MVCC churn on unchanged PetaBencana/BMKG items; [apps/intelligence/src/providers/google-ai-adapter.ts](../../apps/intelligence/src/providers/google-ai-adapter.ts) serializes embedding calls instead of batching (`batchEmbedContents`).
3. **Missing embedding metadata filter in pgvector query:** [apps/intelligence/src/services/semantic-retrieval-service.ts](../../apps/intelligence/src/services/semantic-retrieval-service.ts) omits `provider`, `model_version`, `dimensions`, and `vector_index_version` filters in the direct pgvector SQL query.
4. **`SET ROLE` interleaving hazard:** [tools/hosted/retention-purge.ts](../../tools/hosted/retention-purge.ts) executes `SET ROLE`, `SELECT`, and `RESET ROLE` outside `transaction()` on the shared single-connection `HostedSession`.

### 3.3 Web Frontend (`apps/web`) — Feeds Directly into `PERF-09` & `GUI-03`

1. **Main bundle & CSS bloat (`PERF-09`):**
   - **76 KB** `osm-reference-snapshot.json` eagerly bundled into main chunk ([apps/web/src/MapHome.tsx](../../apps/web/src/MapHome.tsx) -> [apps/web/src/emergency-facilities.ts](../../apps/web/src/emergency-facilities.ts)) even though facilities default to OFF.
   - **42.6 KB** [apps/web/src/SourcePointMap.tsx](../../apps/web/src/SourcePointMap.tsx) + module-level 33x33 offset loop pulled into main chunk solely for pure Mercator/tile helpers imported by [apps/web/src/EventMapCanvas.tsx](../../apps/web/src/EventMapCanvas.tsx).
   - **~74 KB (3,184 lines)** of admin/3D/source-preview CSS eagerly imported in [apps/web/src/main.tsx](../../apps/web/src/main.tsx), while primary `#peta` CSS (`map-home.css`, `incident-map.css`) is dynamically imported inside `MapHome.tsx` / `EventMapCanvas.tsx` (causing FOUC/layout shift).
   - Secondary public/auth screens (`AccountPages.tsx` 46.7 KB, `UpdatesCenter.tsx` 33.3 KB, `MapPanel.tsx` 29.6 KB, `EventDetail.tsx` 23.4 KB, and `EventFeed.tsx` 15.4 KB imported only for `DEFAULT_FEED_FILTERS`) are all eager in [apps/web/src/App.tsx](../../apps/web/src/App.tsx).
   - `<link rel="preconnect" href="https://tile.openstreetmap.org" crossorigin />` in [apps/web/index.html](../../apps/web/index.html) mismatches tile `<img>` tags without `crossOrigin`, opening an unused TLS socket.
2. **Wasteful network waterfall & polling:**
   - **Dead SSE stream on every tab:** [apps/web/src/App.tsx](../../apps/web/src/App.tsx) opens `EventSource("/api/v1/events/stream")` and writes into unread `events`/`status` state, causing full `App` re-renders and holding an idle Worker stream.
   - **Duplicate session & context fetches:** `/api/v1/auth/session` fires 2x on auth pages and 3–4x on `#admin/tinjau` (because `AdminWorkspace` does not pass `session.csrf_token` down to `ModeratorReview` / `PublishedEventModeration`); `/api/v1/context` resets to `null` and refetches on every route change; returning from `#detail` to `#peta` re-fetches events + GeoJSON from scratch.
   - **`NOTIFY-01` resets on every `hashchange`:** [apps/web/src/useInterestNotifications.ts](../../apps/web/src/useInterestNotifications.ts) tears down and recreates the notifier on every hash navigation (clearing cursor and firing immediate `/api/v1/updates` polls), with no multi-tab coordination (`BroadcastChannel`).
   - `#alur-agen` ([apps/web/src/PipelineFlow.tsx](../../apps/web/src/PipelineFlow.tsx)) polls every 5 s despite holding an SSE stream, and re-fetches open drawer items every 5 s without `AbortController`. Core methods in [apps/web/src/api-client.ts](../../apps/web/src/api-client.ts) do not accept `AbortSignal`.
3. **Map & 3D rendering jank (`GUI-03`):**
   - Pan/zoom/glide updates `view` state in [apps/web/src/MapHome.tsx](../../apps/web/src/MapHome.tsx), re-rendering the unmemoized, unvirtualized `MapEventList` (up to 500 cards, each running `countIndependentSources`) at 60–120 fps.
   - Synchronous `getBoundingClientRect()` inside render (`islandInset()` in `MapHome.tsx`) and on every `pointermove`; tiles/markers positioned with layout-triggering `left`/`top` instead of `transform: translate3d`; tile URL regex validation runs per tile per frame; 6–7 `backdrop-filter: blur(18px)` overlays sit on top of CSS-filtered map tiles ([apps/web/src/design/v3.css](../../apps/web/src/design/v3.css)).
   - [apps/web/src/Embedding3DVisualization.tsx](../../apps/web/src/Embedding3DVisualization.tsx) leaks 300 `MeshStandardMaterial`s and geometries on unmount, runs a continuous 60 fps `requestAnimationFrame` loop even when idle/hidden, and raycasts + re-renders a 300-row table on every `mousemove` pixel.

### 3.4 Mobile Flutter (`apps/mobile`) — Feeds into `MOBILE-REL-01` & `GUI-03`

1. **`NOTIFY-01` battery/network overhead & notification reliability gaps:**
   - [apps/mobile/lib/src/interest_notifications.dart](../../apps/mobile/lib/src/interest_notifications.dart) (`runNotifyCycle`) serially fetches up to 100 full `EventDetail` payloads per run; silently advances the cursor past stale KV responses (`detail.version < change.version`), permanently dropping alerts; invokes `show()` before saving state (duplicate window on crash); pollutes the 200-key `notified` set with non-matching events.
   - **Cross-isolate `SharedPreferences` staleness:** [apps/mobile/lib/src/preferences.dart](../../apps/mobile/lib/src/preferences.dart) calls `SharedPreferences.getInstance()` without `.reload()`, so foreground preference/toggle edits can be missed by the WorkManager background isolate.
   - Clearing all interests in [apps/mobile/lib/src/preferences_screen.dart](../../apps/mobile/lib/src/preferences_screen.dart) does not cancel the 15-min WorkManager task; WorkManager omits `requiresBatteryNotLow: true`; background `http.Client` is never closed.
2. **Zero ETag/304 & zero cross-tab caching:**
   - [apps/mobile/lib/src/public_api.dart](../../apps/mobile/lib/src/public_api.dart) sends `cache-control: no-store` and rejects HTTP 304; each tab refetches `/context` and `/events` independently (Map fetches up to 5 pages serially) and wipes existing UI state before awaiting refreshes.
3. **Rendering, invariant remnant & release readiness:**
   - Eager `ListView(children: [...])`, `IntrinsicHeight` in every event card, O(P x E) pin lookup in `MapScreen.build`, per-frame `Paint`/`Path` allocation in `_JakartaPainter`, 12 concurrent `AnimationController`s for skeleton cards.
   - **Invariant remnant:** `IncidentSeverity.affectedRadiusMeters` (250 m–1,500 m) in [apps/mobile/lib/src/public_models.dart](../../apps/mobile/lib/src/public_models.dart) contradicts the no-invented-radius invariant; `EventDetailScreen` hides `source.retrievedAt` despite the Worker sending it (`POLISH-02` regression).
   - **Release config (`MOBILE-REL-01`):** [apps/mobile/android/app/build.gradle.kts](../../apps/mobile/android/app/build.gradle.kts) lacks `buildTypes { release }`, R8/ProGuard (`isMinifyEnabled` / `isShrinkResources`), and `signingConfigs`; 5 full static TTF fonts (632 KB) are bundled.

---

## 4. P2 — Perf Test Blind Spots, CI/CD, A11y & Edge Cases

1. **Performance benchmark blind spots ([tools/perf/nfr04-run.ts](../../tools/perf/nfr04-run.ts), [tools/perf/http-reads.ts](../../tools/perf/http-reads.ts)):**
   - Both scripts discard warmup requests and complete within the 15 s isolate memo TTL, never exercising cold Neon wake-up, KV staleness, filtered/bbox DB fallback paths, auth `FOR UPDATE` contention, or 500–5,000 event datasets. `nfr04-run.ts` omits non-200/304 responses from latency percentiles.
   - Note: `PERF-08` (`65075a5`) added `Server-Timing` on snapshot responses and `tools/perf/latency-probe.ts`, leaving DB-fallback/error `Server-Timing` and cold/filtered probes as remaining extensions.
2. **CI/CD ([.github/workflows/ci.yml](../../.github/workflows/ci.yml), [.github/workflows/ingest.yml](../../.github/workflows/ingest.yml)):**
   - No Flutter `analyze`/`test` job in `ci.yml` (which allowed the `application/geo+json` regression).
   - `deploy` job has no check that `GITHUB_SHA` is current `main` HEAD (risk of older run overwriting newer deploy); smoke check omits `/events.geojson`, `/updates`, and `dataset_mode == "live"`; `test` job lacks `timeout-minutes`; `npm ci` and web builds repeat 3x; Playwright Chromium is not cached.
   - `ingest.yml` runs full workspace `npm ci` (installing Playwright/Vite/Wrangler/PGlite) 48x/day, has no DB advisory lock, and Worker cron dispatch failures are 99% invisible under `head_sampling_rate = 0.01` and `invocation_logs = false` ([apps/worker/wrangler.toml](../../apps/worker/wrangler.toml)).
3. **Web UX & A11y edge cases (`GUI-03`):**
   - `NOTIFY-01`: unsaved draft interests enable the UI switch without starting the notifier ([apps/web/src/Preferences.tsx](../../apps/web/src/Preferences.tsx)); clearing local data on `#privasi` leaves `waspada-jakarta:notify:v1` behind ([apps/web/src/privacy-store.ts](../../apps/web/src/privacy-store.ts)).
   - Auth/moderation: `PasswordChangeForm` discards rotated CSRF tokens ([apps/web/src/AccountPages.tsx](../../apps/web/src/AccountPages.tsx)); `PublishedEventModeration` only loads page 1 and does not update local event `version` after a correction.
   - A11y: missing `tabIndex={-1}` on `<main id="main-content">` on 4 screens (breaks skip link); `<dt>/<dd>` without `<dl>` in [apps/web/src/EventDetail.tsx](../../apps/web/src/EventDetail.tsx); `ModeratorReview` approval modal lacks focus trap and Escape dismiss; invalid `cx`/`cy` attributes on `<text>` in [apps/web/src/InteractiveIncidentMap.tsx](../../apps/web/src/InteractiveIncidentMap.tsx).

---

## 5. Recommended Alignment with Active Workstreams (`AGENT_WORKLOG.md` Section 2)

| Active / Proposed Track | Audit Items to Fold In | Expected Impact |
| --- | --- | --- |
| **`PERF-06` (+ `PERF-05` trial)** | Push snapshot + generation key from ingest/moderator to KV; skip `AUTH_HYPERDRIVE` connect when no cookie/bearer; filter `/events` and `/events.geojson` from snapshot in memory; fix `061`/`060` `DISTINCT ON`; move retention purge & backfills to 1x/day; fix cross-request Promise/env state | Eliminates 1+ s cold Neon path on public reads; protects 100 CU-h Neon & 1,000 KV writes/day ceilings |
| **`PERF-09`** | Lazy-load 76 KB OSM facilities JSON; extract pure Mercator helpers out of `SourcePointMap.tsx` (42.6 KB); split 74 KB admin/3D CSS out of `main.tsx` and load `map-home.css` eagerly; remove dead SSE in `App.tsx`; fix `preconnect` CORS mode | Cuts ~192 KB from initial payload, removes FOUC and idle Worker stream |
| **New small fix PR (`FIX-LIVE-P0`)** | Accept `application/geo+json` in mobile `public_api.dart`; forward `reason`/`evidence_label`/`resolved_category` in `worker/src/index.ts`; relax `hasExactKeys` + add `other`/`unclassified` in web parsers; remove live synthetic fallback in `embedding-visualization-handler.ts`; move auth `cleanupExpired` after throttle & avoid `FOR UPDATE OF a` in `readSession` | Closes all P0 live/security regressions |
| **`MOBILE-REL-01` & `GUI-03`** | Add R8/ProGuard/signing config; fix `NOTIFY-01` (web `hashchange`, mobile N+1/cursor lag/`SharedPreferences.reload`); add ETag/304 + shared cache on mobile; remove `affectedRadiusMeters` remnant; isolate web map pan/zoom state + `translate3d` + fix A11y skip-link/modal | Production-ready Android release, battery-safe notifications, smooth 60 fps map |
| **CI hygiene (`CI-02`)** | Add Flutter `analyze`/`test` job, `main` HEAD guard on deploy, stronger smoke checks, Playwright cache, and cron failure observability (`invocation_logs = true` or alert) | Prevents mobile & deploy regressions automatically |
