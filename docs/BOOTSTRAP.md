# BOOT-01 local bootstrap

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

No live sources, model calls, database, moderator authentication, publication writes, push, cloud resources, or deployment are implemented. The synthetic fixtures are not incident reports and must not be treated as current warnings or evidence of safety.
