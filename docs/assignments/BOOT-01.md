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
