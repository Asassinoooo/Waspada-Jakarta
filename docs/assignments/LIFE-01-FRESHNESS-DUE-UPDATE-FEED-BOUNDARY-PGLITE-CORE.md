# LIFE-01-FRESHNESS-DUE-UPDATE-FEED-BOUNDARY-PGLITE-CORE — due transitions stay out of the public update feed

- **Status:** Assigned as a test-only local composition.
- **Backlog ID:** `LIFE-01-FRESHNESS-DUE-UPDATE-FEED-BOUNDARY-PGLITE-CORE`
- **Objective:** Prove a Layer 4 due-freshness evaluation changes current-public freshness without creating a public event-version update or advancing the exact-live `/api/v1/updates` cursor.
- **Dependencies:** `LIFE-01-FRESHNESS-DUE-COMPOSITION-PGLITE-CORE`, `API-PUBLIC-UPDATES-RUNTIME-CORE`, `API-PUBLIC-UPDATES-READER-CORE`, `API-PUBLIC-UPDATES-PROJECTION-CORE`, `DB-TEST-RUNNER-ISOLATION`; ADR-026/032/038.
- **Requirements:** FR-10/11/13; NFR-01/04/05/07.
- **Contract baseline:** Existing due-evaluator inputs, append-only freshness ledger, current-public projection, exact-live updates handler/runtime, `UpdatePage`, and cursor codec. No schema, migration, API, DTO, OpenAPI, or cursor-contract change.
- **Branch/worktree:** Use branch `work/LIFE-01-FRESHNESS-DUE-UPDATE-FEED-BOUNDARY-PGLITE-CORE` in `.codex-build/worktrees/life-01-freshness-due-update-feed-boundary-pglite-core`, based on the pushed assignment commit. Root records the exact base in the dispatch. Do not edit through the root checkout.
- **Model:** GPT-6 Luna, max reasoning.

## Read before editing

Read `AGENTS.md`, `SOFTWARE_DEVELOPMENT_PLAN.md`, `docs/IMPLEMENTATION_BACKLOG.md`, this assignment, [ADR-026](../decisions/ADR-026-public-update-feed-cursor.md), [ADR-032](../decisions/ADR-032-review-deadline-freshness.md), [ADR-038](../decisions/ADR-038-freshness-due-evaluator.md), the accepted [due-evaluator composition](../../apps/db/test/freshness-due-evaluator-composition.test.ts), the accepted [source-withdrawal update-feed boundary](API-01-LIFE-01-UPDATE-FEED-BOUNDARY-PGLITE-CORE.md), the [updates runtime](../../apps/worker/src/runtime/public-event-updates-runtime.ts), and the [API handler](../../apps/worker/src/layers/l4-application-integration/api.ts). Confirm the due evaluator's explicit-time behavior, public freshness projection, live namespace filter, and existing PGlite HTTP/runtime seams before editing.

## Required behavior

1. Extend only `apps/db/test/freshness-due-evaluator-composition.test.ts` and this assignment's implementation handoff. Keep all records in a disposable PGlite database and author every fixture value locally.
2. The exact-live update runtime reads only the live dataset namespace. If required, mark the authored fixture's `dataset_kind` as `live` only inside this disposable PGlite database to exercise that code path; do not connect to or write any shared, hosted, or real live database. Keep the record content and provenance explicitly fictional and do not use source data or claim any source rights.
3. Before the existing due evaluation, call the actual `GET /api/v1/updates` handler in exact-live mode through `createPublicEventUpdatesRuntime`. Use the same PGlite database, an injected request-scoped SQL runner under `waspada_public_reader`, a fixed cursor key, and fixed request time. Retain the opaque baseline cursor and its decoded sequence.
4. Run the real due-target reader, bounded evaluator, deterministic recorder, and SQL freshness ledger with the existing explicit evaluation instant. Preserve assertions that the transition is append-only, the current-public event/impact freshness reflects the transition, and immutable publication versions, decisions, and outbox rows remain unchanged.
5. Call the actual updates handler/runtime with the baseline cursor. Assert an empty update page and prove with the existing cursor codec that the returned watermark sequence equals the baseline sequence. Keep the public response closed to internal freshness/source data. Do not add a history review decision to fabricate a public correction.
6. This is a producer-specific regression for the due evaluator. Do not reproduce the source-withdrawal scenario, modify production logic, enable a scheduled freshness Worker, or assert hosted PostgreSQL/Neon behavior.

## Allowed paths

- `apps/db/test/freshness-due-evaluator-composition.test.ts`
- `docs/assignments/LIFE-01-FRESHNESS-DUE-UPDATE-FEED-BOUNDARY-PGLITE-CORE.md` (implementation handoff section only)

No production code, API/DTO/OpenAPI, route registration, schema, migration, grant, dependency, configuration, source/provider, external service, deployment, or live data change is authorized.

## Acceptance and verification

- One PGlite composition runs the exact-live updates handler before and after the due evaluation against the same fixture database; it proves the freshness transition changes the current-public projection while `/updates` returns no new items and the decoded cursor sequence stays unchanged.
- Run in WSL Ubuntu-26.04 with existing dependencies: focused `npm exec --no -- tsx --test apps/db/test/freshness-due-evaluator-composition.test.ts`, `npm run db:test`, `npm test`, `npm run typecheck`, `npm run build`, and `git diff --check <assigned-base>..HEAD`. Record WSL, Node, npm, PGlite versions and actual outcomes. Do not install packages or contact any provider/source.
- Commit the test and handoff in coherent descriptive commits on the assigned branch, leave the worktree clean, and do not merge or push. Root independently reviews and integrates accepted work.

Stop and report if exact-live API composition requires a production, contract, schema, grant, dependency, shared-database, or external-service change. Escalate to GPT-6 Astra xhigh only after a GPT-6 Luna Max attempt fails on a substantive technical difficulty; usage limits or scheduling delays are not technical failure.

## Implementation handoff

Append branch/worktree, exact assigned base, commit SHAs/messages, changed paths, behavior, actual WSL checks, runtime versions, limitations, configuration impact, and remaining decisions here. Do not merge or push.
