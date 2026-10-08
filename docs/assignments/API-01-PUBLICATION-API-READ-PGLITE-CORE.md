# API-01-PUBLICATION-API-READ-PGLITE-CORE — read a published correction through list and detail handlers

- **Status:** Assigned for a test-only local composition.
- **Backlog ID:** `API-01-PUBLICATION-API-READ-PGLITE-CORE`
- **Dependencies:** PUB-01-MANUAL-GATE-CORE, PUB-01-REVIEWED-EVIDENCE-LABEL-CORE, PUB-01-MANUAL-GATE-PGLITE-CORE, API-PUBLIC-EVENT-LIST-RUNTIME-CORE, API-PUBLIC-DETAIL-RUNTIME-CORE, DB-TEST-RUNNER-ISOLATION; ADR-012/013/028/052.
- **Requirements:** FR-08/09/10/13; NFR-01/05/07.
- **Contract baseline:** EventProposal, Event, EventPage and EventDetail schema 2.0/public DTOs. Do not change API/OpenAPI contracts.
- **Branch/worktree:** Create `work/API-01-PUBLICATION-API-READ-PGLITE-CORE` in its own worktree under `.codex-build/worktrees/api-01-publication-api-read-pglite-core`, based on pushed `main` after this assignment commit. Do not edit through the root checkout.
- **Model:** GPT-6 Luna, max reasoning.

## Objective

Extend the accepted synthetic publication/read-chain proof so an initial event and its correction, written through the existing manual gate and SQL writer, are readable as the current version through the existing exact-live public list and detail handler paths. This is a disposable PGlite test only; it does not enable moderator writes in the course demo.

## Read first

- `AGENTS.md`
- `SOFTWARE_DEVELOPMENT_PLAN.md`
- `docs/IMPLEMENTATION_BACKLOG.md`
- `docs/decisions/ADR-012-public-projection-boundary.md`
- `docs/decisions/ADR-013-publication-write-transaction.md`
- `docs/decisions/ADR-028-read-only-moderator-demo.md`
- `docs/decisions/ADR-052-moderator-selected-public-evidence-labels.md`
- `docs/assignments/PUB-01-PUBLIC-READ-CHAIN-PGLITE-CORE.md`
- `docs/assignments/PUB-01-MANUAL-GATE-PGLITE-CORE.md`
- `docs/assignments/API-PUBLIC-EVENT-LIST-RUNTIME-CORE.md`
- `docs/assignments/API-PUBLIC-DETAIL-RUNTIME-CORE.md`
- `apps/db/test/manual-publication-public-read-chain.test.ts`
- the existing event-list and event-detail runtime tests/handlers.

## Required behavior

1. Extend only the existing publication/history PGlite composition in `apps/db/test/manual-publication-public-read-chain.test.ts`. Use the actual accepted persisted-proposal reader, manual publication gate, SQL writer, and existing public list/detail handler/runtime seams.
2. Publish the initial version and correction through the same accepted L4 path with explicit moderator-selected labels for each published claim. Do not insert published event rows directly to bypass the gate.
3. Use exact-live request context only inside the ephemeral PGlite test database and call the existing `GET /api/v1/events` and `GET /api/v1/events/{event_id}` handler paths with injected test runtimes. Verify both identify the corrected current version, with version and public fields consistent with what the writer persisted.
4. Assert public allowlists exclude private proposal, evidence/source body, trace, reviewer, and moderator fields. Preserve existing history/update-feed assertions and their reviewed summaries/disclosure rules.
5. Keep every row and reviewer identity fictional, test-only, and database-local. Do not add a browser fixture, demo/live data blend, route registration, moderator identity, runtime wiring, or successful publication behavior in the shipped demo.
6. If accepted reader seams cannot be composed without production/schema/auth changes, stop and report the specific gap.

## Allowed paths

- `apps/db/test/manual-publication-public-read-chain.test.ts`
- `docs/assignments/API-01-PUBLICATION-API-READ-PGLITE-CORE.md` (handoff section only)

No production code, UI, route, schema, migration, grant, API/OpenAPI/DTO, package/dependency, runtime configuration, source/provider, identity/auth, external service, or deployment change is authorized.

## Acceptance and verification

- The successful L4-written corrected event is visible as current through both public list and detail handlers using exact existing projections and allowlists; existing history/update checks continue to pass.
- Run in WSL Ubuntu-26.04 with existing dependencies: focused composition test, `npm run db:test`, `npm test`, `npm run typecheck`, `npm run build`, and `git diff --check <assigned-base>..HEAD`. Record actual versions and results.
- Commit the test and handoff on the task branch. Do not push or merge. Root independently reviews and integrates accepted work.

Stop if the composition requires changing the public contract, adding a route/runtime, bypassing L4 authorization, source rights, real moderator identity, hosted Neon or new dependencies. Escalate to GPT-6 Astra xhigh only after a Luna/max attempt leaves a substantive technical issue unresolved.

## Implementer handoff

- **Branch/worktree:** `work/API-01-PUBLICATION-API-READ-PGLITE-CORE` at `D:\Projects\RPL\.codex-build\worktrees\api-01-publication-api-read-pglite-core` (WSL: `/mnt/d/Projects/RPL/.codex-build/worktrees/api-01-publication-api-read-pglite-core`)
- **Exact base:** `3b6f9b15834047775054154f0454521a48b94ea3`
- **Implementation commit:** `0db67d8649ceda82d4b5d0cac3878960c83f8a39` — `test(API-01): cover corrected publication API reads`
- **Changed paths:** `apps/db/test/manual-publication-public-read-chain.test.ts`; this assignment handoff section.
- **Behavior:** The disposable PGlite composition publishes an initial event and correction through the accepted persisted-proposal reader, L4 manual gate, and SQL writer, then calls the existing exact-live `GET /api/v1/events` and `GET /api/v1/events/{event_id}` handler/runtime paths with an injected SQL executor under the public-reader role. It verifies both responses expose the corrected version and writer-persisted identity, title, summary, category, lifecycle, publication time, claim text, and moderator-selected evidence labels; list/detail EventViews agree; no unsupported geometry is inferred; approved source/scope lookup projections are used; and closed DTO allowlists omit private proposal, evidence, source-body, trace, reviewer, and moderator data. Existing history/disclosure and update-feed checks remain in place.
- **Checks run in WSL Ubuntu-26.04:** `npm exec -- tsx --test apps/db/test/manual-publication-public-read-chain.test.ts` passed (3/3); `npm run db:test` passed (44/44 files); `npm test` passed (web 60/60, Worker 451/451, DB 44/44, evaluation casebook 19/19); `npm run typecheck` passed; `npm run build` passed (Vite production build and Wrangler `--dry-run`). `git diff --check 3b6f9b15834047775054154f0454521a48b94ea3..HEAD` passed after the implementation commit. Runtime/dependency versions: Ubuntu 26.04, Node `24.21.0`, npm `11.19.0`, Git `2.53.0`, PGlite `0.5.8`, `pg` `8.16.3`, tsx `4.23.15`, TypeScript `7.0.2`, Vite `8.3.0`, Wrangler `4.137.0`.
- **Limitations:** All event, attribution, scope-name, reviewer, and disclosure data is fictional and database-local. The fake `hyperdrive.example.invalid` connection is accepted only by the injected test executor; no source or external service is contacted. This verifies local PGlite/handler composition, not hosted Neon or deployed Cloudflare behavior, real source rights, moderator identity, or real authorization.
- **Migration/configuration impact:** None. No production code, migration, route, API/OpenAPI/DTO, identity/authentication, dependency, configuration, source/provider, or shipped-demo behavior changed.
- **Remaining decisions:** None for this test-only slice. It does not authorize moderator writes in the shipped demo or activate a live source.

Append exact branch/worktree, base, commit SHAs/messages, changed paths, behavior, actual checks, versions, limitations and remaining decisions here after committing.
