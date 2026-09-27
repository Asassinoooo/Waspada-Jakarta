# API-PUBLIC-CONTEXT-RUNTIME-CORE — expose the deployment-selected public context

- **Backlog ID:** `API-PUBLIC-CONTEXT-RUNTIME-CORE`
- **Objective:** Make the existing read-only `GET /api/v1/context` endpoint report the exact server-selected live mode while preserving the accepted `PublicContext` response shape and honest source status.
- **Dependencies:** BOOT-01, SPEC-03, existing `PublicContext` contract, existing `SourceStatusProvider` / `noConfiguredSources`.
- **Requirements:** FR-01/10; NFR-07.
- **Layer:** L4 route and response composition, using the existing L1 public source-status interface. Do not add L1 source registration or acquisition.
- **Contract boundary:** Keep the endpoint path, method, status envelope, `PublicContext` fields, and OpenAPI schema unchanged. The runtime-selected dataset mode comes only from Worker configuration; query parameters and headers cannot select it.
- **Branch/worktree:** `work/API-PUBLIC-CONTEXT-RUNTIME-CORE` in the reusable managed checkout `C:\Users\perry\.codex\worktrees\api-geojson-route-core\RPL` (WSL: `/mnt/c/Users/perry/.codex/worktrees/api-geojson-route-core/RPL`), created from pushed `main` after this assignment lands. Do not edit through the root checkout.
- **Owner:** GPT-6 Luna Max implementation agent. Root plans, reviews, integrates, and pushes.

## Read first

- `AGENTS.md`
- `SOFTWARE_DEVELOPMENT_PLAN.md` (first repository document), then `docs/IMPLEMENTATION_BACKLOG.md` and this assignment
- `docs/UX_API_SPEC.md`, `docs/api/openapi.yaml` (`GET /context`), and `apps/worker/src/contracts/public-api.ts`
- `apps/worker/src/layers/l4-application-integration/api.ts`, `public-read-model.ts`, `apps/worker/src/layers/l1-data-knowledge/source-status.ts`, `apps/worker/src/index.ts`, and `apps/worker/test/api.test.ts`

## Scope and invariants

The API currently returns a synthetic context in demo mode and rejects `/context` in exact live mode, even though the accepted contract defines both `dataset_mode: "live"` and `dataset_label: "live"`. Add the bounded live response for the existing contract. The endpoint reports the runtime's configured dataset mode; it does not certify connector health or the availability, freshness, completeness, or safety of incident information.

The current `noConfiguredSources` provider returns an empty list. Preserve that result as an honest indication that no connectors are registered. Do not invent source names, health, timestamps, or status based on the `DATASET_MODE` value. Do not connect to the database: this route composes only the server-selected label and the existing public source-status provider. A live context response may therefore contain `sources: []`.

The user has decided that a withdrawn event and all its public version history remain hidden. This task does not touch event or history routes; do not weaken their existing behavior.

## Allowed paths

- `apps/worker/src/layers/l4-application-integration/api.ts`
- `apps/worker/src/layers/l4-application-integration/public-read-model.ts`
- Focused tests under `apps/worker/test/`
- This assignment's implementation handoff only

Do not edit `apps/worker/src/index.ts`, `apps/worker/src/contracts/public-api.ts`, OpenAPI, migrations, database readers/roles, package manifests, lockfiles, Wrangler configuration, source registry/provider implementations, UI, other assignments, or other product documents. No dependency, DB connection, external service, secret, binding, source access, or live data is authorized.

## Acceptance criteria

1. `GET /api/v1/context` in exact `DATASET_MODE=live` returns HTTP 200 with the existing `PublicContext` shape, `dataset_mode: "live"`, `dataset_label: "live"`, a server-generated `generated_at`, and the existing provider's public source-status list.
2. With the current no-configured-source provider, the live response returns `sources: []`; it does not fabricate connector health or assert that there are no incidents.
3. Demo mode and an omitted mode preserve the current synthetic response. Browser-supplied headers or query parameters cannot change the server-selected mode.
4. Unknown configured modes remain unavailable. Non-GET requests remain read-only errors. The exact-live gate for every other route remains unchanged, including 503 when a live route lacks its required injected runtime.
5. No SQL executor, Hyperdrive, database, source fetch, or model is initialized or called for this context response. Tests verify that the response remains bounded and exposes no private fields.
6. The API/DTO/OpenAPI contract shape, demo behavior, source provider, and telemetry privacy behavior stay unchanged.

## Verification commands

Run in WSL Ubuntu-26.04 from the repository root, using the existing locked dependencies and mocked/injected providers only:

```bash
npm test --workspace=@waspada/worker
npm test
npm run typecheck
npm run build
git diff --check
```

Record exact runtime versions, actual results, limitations, and any skipped checks. Do not describe a check as passing unless it ran.

## Stop conditions

Stop and report the precise gap if implementing the response requires a schema/contract change, DB or provider access, fabricated source-status information, or relaxation of another live-route gate. Do not add such work to this assignment. Escalate to GPT-6 Astra xhigh only if a GPT-6 Luna Max attempt encounters a substantive technical difficulty and still cannot resolve it; usage limits or scheduling delays do not qualify.

## Implementation handoff

Implemented on branch `work/API-PUBLIC-CONTEXT-RUNTIME-CORE` in `C:\Users\perry\.codex\worktrees\api-geojson-route-core\RPL` (`/mnt/c/Users/perry/.codex/worktrees/api-geojson-route-core/RPL` in WSL).

- Implementation commit: `ba629841ab5a46284808aa895beef736cb25a491` — `feat(API-PUBLIC-CONTEXT-RUNTIME-CORE): expose exact live public context`.
- Changed paths: `apps/worker/src/layers/l4-application-integration/api.ts`, `apps/worker/src/layers/l4-application-integration/public-read-model.ts`, `apps/worker/test/api.test.ts`, and `apps/worker/test/public-event-list-runtime.test.ts`.
- Behavior: exact server-configured `DATASET_MODE=live` now allows only `GET /api/v1/context` through the existing mode gate and returns the unchanged `PublicContext` with `dataset_mode` and `dataset_label` set to `live`. It uses the current `noConfiguredSources` provider and returns an empty `sources` list. Demo and omitted modes remain synthetic; query/header inputs do not choose mode; unknown modes and writes remain unavailable. Tests assert the exact public field allowlist, generated timestamp, empty source status, and that context does not read Hyperdrive.
- Runtime/dependency versions at implementation start: Ubuntu 26.04 WSL, Node `v24.21.0`, npm `11.19.0`, TypeScript `7.0.2`, tsx `4.23.15`, and Wrangler `4.137.0` (`npm ls --depth=0`). No dependency versions changed.
- Checks: `npm test --workspace=@waspada/worker` passed, 224/224 tests; `npm test` passed with Worker 224/224, DB 18/18 test files, and evaluation 12/12; `npm run typecheck` passed; `npm run build` passed, including Vite production build and Wrangler dry run. The full workspace suite ran before a test-only explicit TypeScript return annotation was added to the Hyperdrive spy; the Worker suite, typecheck, and build were rerun afterward and passed. `git diff --check` passed on the final handoff diff.
- Limitations: no connectors are registered, so `sources: []` reports no configured source status; this response does not measure health, freshness, event availability, completeness, or safety. Hosted Neon and live source behavior remain unverified and out of scope.
- Migration/configuration impact: none. No database, Hyperdrive binding, secret, provider resource, source access, contract, OpenAPI, dependency, migration, or configuration was added or changed.
- Remaining decisions: none for this slice; root review and acceptance remain pending.

The handoff record is committed separately on this task branch. Root independently reviews and integrates both commits.
