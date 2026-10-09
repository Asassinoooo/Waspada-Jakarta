# BOOT-01 local bootstrap

**Current implementation note — 1 October 2026:** the sections below preserve BOOT-01's original setup and verification. Since that checkpoint, local database repositories, typed L2 adapters, bounded L3 components, strict public projectors and credential-gated read runtimes have been accepted. The checked-in Worker still uses labelled demo fixtures and has no configured database binding, live source or model provider. Use SOFTWARE_DEVELOPMENT_PLAN.md and IMPLEMENTATION_BACKLOG.md for current capability status; the historical test counts here are not the current suite totals. All current project verification continues to use WSL Ubuntu-26.04.

This package is a local-only React client and Cloudflare Worker shell. It serves the two public read routes the demo uses: `GET /api/v1/context` and `GET /api/v1/events`. Both responses follow the OpenAPI `PublicContext` and `EventPage` projections. The Worker selects its dataset through server-side `DATASET_MODE=demo` in `apps/worker/wrangler.toml`; browser query parameters and headers cannot switch it. No Cloudflare account, credential, database, or `.env` file is needed.

All fixture content is synthetic. The page persistently shows **DEMO — data sintetis; bukan peringatan langsung**, reports that there are no live sources, and uses an explicit empty state that does not imply safety. An unavailable API is also presented as unknown. The layer modules are separated by responsibility; L2 and L3 are contracts only, and this shell does not implement the wider pipeline.

## WSL runtime used

Verification ran in WSL Ubuntu-26.04 with the native Linux Node.js binary, not Windows Node:

- Node.js `v24.21.0`, installed under `/home/perry/.local/opt/waspada-node-v24.21.0`
- npm `11.19.0`, bundled with that Node.js installation
- Git `2.53.0`

The tested dependency versions are locked in `package-lock.json`:

- Root tools: `concurrently 10.0.5`, `tsx 4.23.15`, `typescript 7.0.2`, `wrangler 4.137.0`, `@types/node 24.13.6`
- Web: `react 19.3.0`, `react-dom 19.3.0`, `vite 8.3.0`, `@vitejs/plugin-react 6.1.1`, `@types/react 19.3.0`, `@types/react-dom 19.3.0`

In a new WSL shell, put a compatible native Linux Node installation first in `PATH`. These are the exact commands used in this environment:

```bash
export PATH="/home/perry/.local/opt/waspada-node-v24.21.0/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
cd /mnt/d/Projects/RPL/.codex-build/worktrees/boot-01
node --version
npm --version
npm ci
```

The install scripts needed by esbuild and workerd are explicitly allowed in the root `package.json`. A clean `npm ci --offline --no-audit --no-fund` also passed here after the package cache was populated; a new machine needs registry access for `npm ci`.

## Run and verify

Start both local services from one WSL terminal:

```bash
npm run dev
```

Vite is served at `http://127.0.0.1:5173/`; it proxies `/api/v1` to the local Worker at `http://127.0.0.1:8787/`. Wrangler's local dev command disables its optional Cloudflare `Request.cf` fetch, and the project disables Wrangler metrics. The runtime does not call an external service.

For a separate concurrent worktree, use distinct local ports without stopping another checkout's services. The experience wave used the commands below in two WSL terminals, with native Linux Node on `PATH`:

```bash
CLOUDFLARE_CF_FETCH_ENABLED=false node_modules/.bin/wrangler dev --config apps/worker/wrangler.toml --local --ip 127.0.0.1 --port 58787
WASPADA_DEV_API_ORIGIN=http://127.0.0.1:58787 WASPADA_DEV_POLLING=1 npm run dev --workspace=@waspada/web -- --port 55173 --strictPort
WASPADA_SMOKE_ORIGIN=http://127.0.0.1:55173 npm run smoke
```

`WASPADA_DEV_POLLING=1` is optional and useful when Windows edits to a `/mnt/c` checkout do not trigger WSL filesystem notifications. It changes local development watching only. Flutter setup is documented separately in [apps/mobile/README.md](../apps/mobile/README.md); no cloud deployment or account is required for the synthetic Worker.

With the services running, use a second WSL terminal in the worktree for the integrated UI/API smoke test. The remaining commands may also be run with the dev process stopped:

```bash
npm run smoke
npm test
npm run typecheck
npm run build
```

The smoke test exercises both proxied read routes and renders the actual returned context and event page into the UI, checking the demo banner and honest empty state. Tests also check the response projection, bounded event filtering, invalid filters, and that browser input cannot select a dataset or mutate the fixture. `npm run build` runs TypeScript checks, a Vite production build, and `wrangler deploy --dry-run`; it does not deploy.

## Recorded WSL verification

Run from the assigned worktree with Node.js `v24.21.0` and npm `11.19.0`:

- `npm ci --offline --no-audit --no-fund` — passed with the populated local npm cache.
- `npm run smoke` — passed against local Vite and Worker; context and event routes returned HTTP 200.
- `npm test` — passed, 6 tests total (2 UI and 4 Worker).
- `npm run typecheck` — passed for both workspaces.
- `npm run build` — passed; Vite production assets built and Wrangler dry-run exited successfully with only the local demo binding.

The Worker demo is not connected to a database; no live sources, model calls, moderator authentication, publication writes, cloud resources, or deployment are implemented. DATA-01 adds a local PostgreSQL schema/repository foundation and test-only in-memory PGlite harness, not runtime database access. The synthetic fixtures are not incident reports and must not be treated as current warnings or evidence of safety.
