# API-01-LIFE-01-UPDATE-FEED-BOUNDARY-PGLITE-CORE — freshness changes do not advance public updates

- **Status:** Assigned for a test-only local composition.
- **Backlog ID:** `API-01-LIFE-01-UPDATE-FEED-BOUNDARY-PGLITE-CORE`
- **Dependencies:** API-01-LIFE-01-PUBLIC-READ-PGLITE-CORE, LIFE-01-SOURCE-REVISION-WITHDRAWN-FRESHNESS-CORE, API-PUBLIC-UPDATES-READER-CORE, API-PUBLIC-UPDATES-PROJECTION-CORE, API-PUBLIC-UPDATES-RUNTIME-CORE, DB-TEST-RUNNER-ISOLATION; ADR-026/042/046/048.
- **Requirements:** FR-10/11/13; NFR-01/04/05/07.
- **Contract baseline:** Existing freshness ledger, update-feed cursor/page, and public event DTOs. No schema, migration, route, OpenAPI, or response contract change.
- **Branch/worktree:** Create `work/API-01-LIFE-01-UPDATE-FEED-BOUNDARY-PGLITE-CORE` in its own worktree under `.codex-build/worktrees/api-01-life-01-update-feed-boundary-pglite-core`, based on pushed `main` after this assignment commit. Do not edit through the root checkout.
- **Model:** GPT-6 Luna, max reasoning.

## Objective

Extend the accepted source-withdrawal PGlite composition to verify the existing ADR-026 rule that a freshness-only transition appears on current event views but does not create a public `/api/v1/updates` entry or advance the update-feed cursor watermark.

## Read first

- `AGENTS.md`
- `SOFTWARE_DEVELOPMENT_PLAN.md`
- `docs/IMPLEMENTATION_BACKLOG.md`
- `docs/decisions/ADR-026-public-update-feed-cursor.md`
- `docs/decisions/ADR-042-source-revision-publication-review.md`
- `docs/decisions/ADR-046-source-revision-freshness.md`
- `docs/decisions/ADR-048-source-report-withdrawn-freshness.md`
- `docs/assignments/API-01-LIFE-01-PUBLIC-READ-PGLITE-CORE.md`
- `docs/assignments/API-PUBLIC-UPDATES-RUNTIME-CORE.md`
- `apps/db/test/source-revision-freshness-transition-composition.test.ts`
- `apps/worker/src/runtime/public-event-updates-runtime.ts`
- `apps/worker/src/layers/l4-application-integration/api.ts`

## Required behavior

1. Extend only `apps/db/test/source-revision-freshness-transition-composition.test.ts`, using its existing authored synthetic source-withdrawal fixture and disposable PGlite database.
2. Before the existing freshness transition runs, bootstrap the existing exact-live updates runtime and retain its opaque baseline cursor. Keep the cursor signing key and request clock fixed for the test; use the accepted runtime/handler seams and the same isolated SQL executor.
3. Run the existing source-withdrawal freshness transition. Preserve the current list, detail, GeoJSON, immutable-publication, and privacy assertions.
4. After the transition, call the real `GET /api/v1/updates` handler with the baseline cursor and injected updates runtime. Assert the response contains no update items, and decode the returned cursor with the existing cursor codec to prove its sequence is unchanged from the baseline. Also assert that neither the update response nor bounded telemetry contains private source-observation, transition, or cursor-signing data.
5. Assert expected request-scoped SQL behavior and fixed public response fields without exposing the opaque cursor or changing the existing DTO. Do not insert a history review decision to fabricate an update.
6. If the existing handler/runtime cannot express this behavior without changing production code, schema, or API contract, stop and report the exact gap.

## Allowed paths

- `apps/db/test/source-revision-freshness-transition-composition.test.ts`
- `docs/assignments/API-01-LIFE-01-UPDATE-FEED-BOUNDARY-PGLITE-CORE.md` (handoff section only)

No production code, route registration, schema, migration, grant, DTO/OpenAPI, dependency, source/provider, configuration, external service, or deployment change is authorized.

## Acceptance and verification

- One PGlite composition captures the baseline cursor before the freshness transition, then proves the event/impact freshness change remains visible through the existing current views while `/updates` has no item and the cursor sequence does not advance.
- Run in WSL Ubuntu-26.04 with existing dependencies: focused `apps/db/test/source-revision-freshness-transition-composition.test.ts`, `npm run db:test`, `npm test`, `npm run typecheck`, `npm run build`, and `git diff --check <assigned-base>..HEAD`. Record actual runtime versions and results.
- Commit the test and handoff on the task branch. Do not push or merge. Root independently reviews and integrates accepted work.

Stop if the task needs a new public contract, review mutation, source rights, real source content, hosted Neon, new dependency, or deployed configuration. No real source, credentials, or external service is authorized. Escalate to GPT-6 Astra xhigh only after a Luna/max attempt leaves a substantive technical issue unresolved.

## Implementer handoff

### Implementation handoff

- **Branch/worktree:** `work/API-01-LIFE-01-UPDATE-FEED-BOUNDARY-PGLITE-CORE` at `.codex-build/worktrees/api-01-life-01-update-feed-boundary-pglite-core`.
- **Exact base:** pushed `main`, `3e1370927c80f1673c3801e043230d1c8d7a737b`.
- **Implementation commit:** `72eb8f9eb35d709000bb0f3d7e3059ce89cc361e` — `test(API-01-LIFE-01): verify freshness does not advance updates`.
- **Changed paths:** `apps/db/test/source-revision-freshness-transition-composition.test.ts` and this handoff section only.
- **Behavior:** the PGlite composition captures the exact-live updates cursor before source withdrawal, preserves its existing current list/detail/GeoJSON checks, then calls the existing updates handler with that cursor. It verifies an empty page and unchanged decoded sequence, fixed page shape, one request-scoped SQL operation per updates request, and no private source, transition, or signing values in the updates response or bounded telemetry.
- **Verification environment:** WSL Ubuntu-26.04; Node `v24.21.0`, npm `11.19.0`, Git `2.53.0`; existing DB manifest pins `@electric-sql/pglite` `0.5.8`.
- **Checks actually run:**
  - `npm exec -- tsx --test apps/db/test/source-revision-freshness-transition-composition.test.ts` — passed, 1/1.
  - `npm run db:test` — passed, 44/44 DB test files.
  - `npm test` — passed, including the web suite and 44/44 DB test files.
  - `npm run typecheck` — passed.
  - `npm run build` — passed; Vite and Wrangler dry-run completed.
  - `git diff --check 3e1370927c80f1673c3801e043230d1c8d7a737b..HEAD` — passed in WSL for the implementation commit.
- **Limitations/configuration impact:** test-only, synthetic fixture and disposable PGlite; no production, API/DTO/OpenAPI, schema/migration/grant, dependency, configuration, source, or runtime behavior change. No credentials, live data, or external services used.
- **Remaining decision:** none for the assigned slice; root review and integration remain pending. The handoff-document commit SHA is supplied in the root task handoff because a commit cannot contain its own SHA.
