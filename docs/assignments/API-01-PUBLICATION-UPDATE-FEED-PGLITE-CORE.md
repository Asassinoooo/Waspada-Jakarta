# API-01-PUBLICATION-UPDATE-FEED-PGLITE-CORE — publish corrections through the updates route

- **Status:** Assigned for a test-only local composition.
- **Backlog ID:** `API-01-PUBLICATION-UPDATE-FEED-PGLITE-CORE`
- **Objective:** Prove an L4-written correction is returned by the existing exact-live `GET /api/v1/updates` handler and runtime from the public update feed.
- **Dependencies:** `API-01-PUBLICATION-API-READ-PGLITE-CORE`, `PUB-01-PUBLIC-READ-CHAIN-PGLITE-CORE`, `LIFE-01-CORRECTION-READ-CHAIN-CORE`, `API-PUBLIC-UPDATES-RUNTIME-CORE`, `API-PUBLIC-UPDATES-READER-CORE`, `API-PUBLIC-UPDATES-PROJECTION-CORE`, `PUB-01-MANUAL-GATE-PGLITE-CORE`, `PUB-WRITE-CORE`, `DB-TEST-RUNNER-ISOLATION`; ADR-020/026/028/052.
- **Requirements:** FR-10/11/13; NFR-01/04/05/07.
- **Contract baseline:** Existing `UpdatePage` and `HistoryEntry` OpenAPI/DTO shapes and update-cursor behavior, plus exact-version moderator-reviewed disclosure metadata. No API, DTO, OpenAPI, schema, migration, or grant change.
- **Branch/worktree:** Use branch `work/API-01-PUBLICATION-UPDATE-FEED-PGLITE-CORE` in `.codex-build/worktrees/api-01-publication-update-feed-pglite-core`, based on the pushed assignment commit. The root dispatch records the exact base SHA. Do not edit through the root checkout.
- **Model:** GPT-6 Luna, max reasoning.

## Read before editing

Read `AGENTS.md`, `SOFTWARE_DEVELOPMENT_PLAN.md`, `docs/IMPLEMENTATION_BACKLOG.md`, this assignment, ADR-020/026/028/052, the accepted [public read-chain composition](../../apps/db/test/manual-publication-public-read-chain.test.ts), the [update runtime](../../apps/worker/src/runtime/public-event-updates-runtime.ts), the [API handler](../../apps/worker/src/layers/l4-application-integration/api.ts), the update reader/projection, and the OpenAPI update operation. Confirm the published-version sequence, timestamp and disclosure semantics and the request-scoped SQL/transaction seam before editing.

## Required behavior

1. Extend only `apps/db/test/manual-publication-public-read-chain.test.ts` and this assignment's implementation handoff. Use its disposable PGlite database, fictional exact-version disclosures, existing L4 manual gate and real SQL publication writer.
2. Before the first publication, issue a request to the actual `GET /api/v1/updates` handler in exact-live mode using the accepted updates runtime and an injected SQL runner backed by the same disposable database under `waspada_public_reader`. Assert an empty page and retain its opaque continuation cursor as the baseline.
3. Publish version 1 and its correction through the existing gate/writer, with the test's authored `published` and `corrected` disclosure rows and exact publication timestamps. Do not fabricate a moderator identity or factual review claim.
4. Request `/api/v1/updates` through the actual handler/runtime with the baseline cursor. Assert both exact-version entries, their event IDs, versions, change types, summaries and publication timestamps; assert the closed `UpdatePage`/`HistoryEntry` key sets and that the cursor advances.
5. Continue with the returned cursor through the actual handler/runtime. Assert the page is empty and contains no duplicate entries. Preserve the existing public list/detail/history assertions and private-value exclusion checks. Keep event publication time separate from cursor checked/expiry times.
6. Exercise the runtime's request-scoped SQL and transaction behavior using only the existing injected test seam. The production runtime, public API response contracts, route gates, telemetry fields, and transaction implementation remain untouched.
7. Use only an ephemeral cursor key, authored fictional database rows, and PGlite. Do not call a real source, hosted database, external provider, model, or service.

## Allowed paths

- `apps/db/test/manual-publication-public-read-chain.test.ts`
- `docs/assignments/API-01-PUBLICATION-UPDATE-FEED-PGLITE-CORE.md` (implementation handoff section only)

No production code, route registration, UI, API/OpenAPI/DTO, database SQL/repository/view/schema/migration/grant, dependency, configuration, source/provider, external service, or deployment change is authorized.

## Acceptance and verification

- One PGlite composition proves the empty HTTP baseline, L4 initial publication and correction, public update-feed delivery through the actual handler/runtime, and duplicate-free cursor continuation. Public response objects contain no reviewer, proposal, source, evidence, signing key, or internal sequence fields.
- Run checks in WSL Ubuntu-26.04 with installed dependencies: `npm exec --no -- tsx --test apps/db/test/manual-publication-public-read-chain.test.ts`, `npm run db:test`, `npm test`, `npm run typecheck`, `npm run build`, and `git diff --check <assigned-base>..HEAD`. Record runtime versions and actual results.
- Commit the test and handoff on the task branch in coherent commits, leave its worktree clean, and do not merge or push. Root independently reviews and integrates accepted work.

Stop and report the exact gap if the actual handler/runtime cannot use the existing PGlite seam without production, schema, grant, dependency, or contract changes. Do not contact a source owner, use real source material, provision a service, or claim hosted Neon behavior. Escalate to GPT-6 Astra xhigh only after a GPT-6 Luna Max attempt fails on a substantive technical difficulty.

## Implementation handoff

Append the branch/worktree, exact base, commit SHAs and messages, changed paths, behavior, actual WSL checks, runtime versions, limitations, configuration impact, and remaining decisions here. Do not merge or push.

### Completed implementation handoff

- **Branch/worktree:** `work/API-01-PUBLICATION-UPDATE-FEED-PGLITE-CORE` at `.codex-build/worktrees/api-01-publication-update-feed-pglite-core`; exact assigned base: `f1f057b722ea9f9f0d16fe61de834316cfe4c39b`.
- **Commits:** `a4e6b11c85762744b47aee9b49c1bfc2d4ae3ff4` (`test(API-01): exercise publication updates route feed`); handoff commit message: `docs(API-01): record publication updates feed handoff` (its full SHA is reported with the final handoff).
- **Changed paths:** `apps/db/test/manual-publication-public-read-chain.test.ts`; this assignment handoff section only.
- **Behavior:** The disposable PGlite composition now captures an empty baseline cursor through the actual exact-live `GET /api/v1/updates` handler before either L4 write, then verifies the initial publication and correction through the handler/runtime and continues from the returned cursor without duplicates. It checks exact disclosure fields and publication timestamps, closed page/entry keys, cursor advancement, request-time/expiry separation, private-value exclusion, and one injected SQL operation with a repeatable-read/read-only transaction per request. Existing public list/detail/history assertions remain in place.
- **Verification environment:** WSL `Ubuntu-26.04`, Linux Node `v24.21.0`, npm `11.19.0`; runtime selected from the preinstalled `/home/perry/.local/share/waspada-node-v24.21.0/bin`.
- **Actual checks:** `npm exec --no -- tsx --test apps/db/test/manual-publication-public-read-chain.test.ts` passed 3/3 on final source; `npm run db:test` passed 44/44 files; `npm test` exited 0 on final source (web 60, Worker 464, DB 44/44 files, evaluation 19); `npm run typecheck` passed; `npm run build` passed, including Vite production build and Wrangler Worker dry-run; the assigned-base `git diff --check f1f057b722ea9f9f0d16fe61de834316cfe4c39b..HEAD` passed in WSL after the handoff commit.
- **Limitations/configuration:** Synthetic authored rows and disposable PGlite only. No production/API/DTO/OpenAPI/database/dependency/configuration change; no migration or grant impact. Hosted Neon, source rights, authenticated reviewer identity, and deployed Worker behavior are not established by this test.
- **Remaining decisions:** None within this test-only assignment; root review and integration remain pending.
