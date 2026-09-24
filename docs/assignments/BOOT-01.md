# BOOT-01 — Runtime and application skeleton

- **Status:** In progress
- **Assigned branch:** `work/BOOT-01-runtime-skeleton`
- **Dependency baseline:** commit `544e0dc` (accepted design contracts and ADR-010)
- **Owner:** Luna Max implementation agent; root reviews and integrates

## Objective

Create the smallest complete, local-only application shell that demonstrates the accepted Waspada Jakarta UI/API boundary and starts, builds and tests in WSL Ubuntu-26.04. Use a React/TypeScript static client and a modular TypeScript Cloudflare Worker API. Show an explicit synthetic demo mode. Keep the five logical AI layers separate in naming/interfaces even though the app is a small module set.

## Allowed paths

- `apps/web/**` and `apps/worker/**`
- Root package/workspace and TypeScript configuration needed for this app (`package.json`, lockfile, `tsconfig*.json`, Vite/Wrangler configuration)
- `.env.example` or equivalent, containing placeholders only
- `docs/BOOTSTRAP.md`
- This assignment file, only to append the actual handoff

Do not edit architecture, contracts, OpenAPI, the backlog, top-level README/SDP or other decisions. If implementation requires a contract or architecture change, stop at that boundary and report it to root.

## Product/runtime boundaries

- Static UI and Worker must run locally without Cloudflare/Neon credentials, provider accounts, external API calls or live-source activation.
- Dataset mode is selected by server/runtime configuration. No query parameter or browser field may switch demo/live data.
- Provide a conspicuous persistent `DEMO — data sintetis; bukan peringatan langsung` label and an honest empty/unavailable state. Empty coverage must not mean “safe.”
- Use a small clearly synthetic fixture. The API only implements read-only context and event-list routes needed by the UI, shaped to the proposed OpenAPI 3.1 `PublicContext` and `EventPage` contracts. No database, scraping, model inference, publication mutation, authentication, or real source evidence is part of this slice.
- Keep interfaces for source/model services unconfigured or mocked; do not add an agent loop.
- Do not add paid-tier services, create cloud resources, deploy, or push.

## Acceptance and verification

- Provide simple WSL run, test, typecheck and production-build commands in `docs/BOOTSTRAP.md`; document the Node/npm versions used and actual results.
- Start the integrated local UI and API in WSL. Verify the two routes and visible demo/empty-data label through automated checks or a local smoke test.
- Verify the API never changes dataset based on client input and that the UI does not claim current safety.
- Commit all coherent work on the assigned branch with a descriptive message such as `feat(BOOT-01): scaffold synthetic Worker demo app`. Include the commit SHA/message and checks in the handoff below. Do not push.

## Handoff

Pending root review. Record actual changed paths, implementation, branch/commit, commands/results, limitations, and any required follow-up before handing off.

## Completed implementation handoff

- **Branch:** work/BOOT-01-runtime-skeleton
- **Worktree:** D:\Projects\RPL\.codex-build\worktrees\boot-01 (WSL: /mnt/d/Projects/RPL/.codex-build/worktrees/boot-01)
- **Implementation commit:** 1421e2497aa08c35f7d694502ab2be494b41678c — feat(BOOT-01): scaffold synthetic Worker demo app
- **Review state:** implementation committed and ready for root review; task status remains subject to root acceptance.

The local app has a React/TypeScript feed shell and a modular TypeScript Worker. The Worker exposes only GET /api/v1/context and GET /api/v1/events, using the PublicContext and EventPage projections. DATASET_MODE=demo is server-side Wrangler configuration; query parameters and headers cannot select a dataset. Fixtures are explicitly synthetic, with no live source data. The persistent Indonesian demo disclaimer, source-unavailable information, empty feed, and unavailable-API state do not imply current safety. The L1–L5 responsibilities have separate modules; L2/L3 are interfaces only. Wrangler local development disables its optional Cloudflare Request.cf fetch, and telemetry is disabled.

**Changed paths in the implementation commit:**

- apps/web/index.html
- apps/web/package.json
- apps/web/src/App.tsx
- apps/web/src/EventFeed.tsx
- apps/web/src/api-client.ts
- apps/web/src/main.tsx
- apps/web/src/styles.css
- apps/web/src/vite-env.d.ts
- apps/web/test/smoke-local.tsx
- apps/web/test/ui.test.tsx
- apps/web/tsconfig.json
- apps/web/vite.config.ts
- apps/worker/package.json
- apps/worker/src/contracts/public-api.ts
- apps/worker/src/index.ts
- apps/worker/src/layers/l1-data-knowledge/source-status.ts
- apps/worker/src/layers/l2-model-grounding/contracts.ts
- apps/worker/src/layers/l3-investigation/contracts.ts
- apps/worker/src/layers/l4-application-integration/api.ts
- apps/worker/src/layers/l4-application-integration/public-read-model.ts
- apps/worker/src/layers/l4-application-integration/synthetic-fixtures.ts
- apps/worker/src/layers/l5-evaluation-monitoring/telemetry.ts
- apps/worker/test/api.test.ts
- apps/worker/tsconfig.json
- apps/worker/wrangler.toml
- docs/BOOTSTRAP.md
- package-lock.json
- package.json
- tsconfig.json

**Actual WSL checks (Ubuntu-26.04; native Node.js 24.21.0 and npm 11.19.0):**

- npm ci --offline --no-audit --no-fund — passed with the populated WSL npm cache.
- npm run dev — Vite and local Wrangler started; no external Request.cf lookup was attempted.
- npm run smoke — passed through Vite's API proxy; /api/v1/context and /api/v1/events returned HTTP 200 and the rendered UI assertions passed.
- npm test — passed: 6 tests (2 UI, 4 Worker), 0 failures.
- npm run typecheck — passed for both workspaces.
- npm run build — passed TypeScript checks, Vite production build, and Wrangler deploy --dry-run; no deployment occurred.
- git diff --cached --check — passed before commit.

**Limitations and remaining decisions:** no database, scraping, model call, agent loop, live-source activation, moderator authentication, event publication/mutation, cloud resources, push, or deployment is implemented. Event fixtures are not real reports. No contract or architecture change, migration, credential, or external provider setup was needed. Root review/integration remains; later API, source, publication, and UI work stays with its assigned backlog tasks.
