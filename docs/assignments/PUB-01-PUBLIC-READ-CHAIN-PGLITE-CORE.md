# PUB-01-PUBLIC-READ-CHAIN-PGLITE-CORE — Verify reviewed publication history through public readers

- **Status:** Assigned for local synthetic test implementation
- **Depends on:** PUB-01-MANUAL-GATE-CORE, PUB-01-REVIEWED-EVIDENCE-LABEL-CORE, PUB-01-MANUAL-GATE-PGLITE-CORE, PUB-WRITE-CORE, API-PUBLIC-HISTORY-READER-CORE, API-PUBLIC-HISTORY-REVIEW-METADATA-CORE, API-PUBLIC-HISTORY-PROJECTION-CORE, API-PUBLIC-UPDATES-READER-CORE, API-PUBLIC-UPDATES-PROJECTION-CORE, DB-TEST-RUNNER-ISOLATION, ADR-020/026/028/052
- **Requirements:** FR-08/10/12/13; NFR-01/05/07
- **Architecture:** Test-only Layer 4 publication/history composition
- **Branch/worktree:** work/PUB-01-PUBLIC-READ-CHAIN-PGLITE-CORE; .codex-build/worktrees/pub-01-public-read-chain-pglite-core
- **Contracts:** EventProposal, Event, HistoryPage and UpdatePage schema 2.0/public DTOs remain unchanged
- **Owner:** GPT-6 Luna Max implementation agent; root plans and reviews

## Objective

Add an isolated PGlite composition proving a publication produced by the accepted manual gate and SQL writer can be read through the existing moderator-reviewed public history and update-feed projections. Exercise a publication and a corrected version, with exact-version synthetic disclosure fixtures, while keeping claim evidence labels distinct from history disclosure labels and summaries.

## Read first

- AGENTS.md
- SOFTWARE_DEVELOPMENT_PLAN.md
- docs/IMPLEMENTATION_BACKLOG.md
- docs/decisions/ADR-020-public-event-history-disclosure.md
- docs/decisions/ADR-026-public-update-feed-cursor.md
- docs/decisions/ADR-028-read-only-moderator-demo.md
- docs/decisions/ADR-052-moderator-selected-public-evidence-labels.md
- docs/assignments/PUB-01-MANUAL-GATE-CORE.md
- docs/assignments/PUB-01-REVIEWED-EVIDENCE-LABEL-CORE.md
- docs/assignments/PUB-01-MANUAL-GATE-PGLITE-CORE.md
- docs/assignments/API-PUBLIC-HISTORY-READER-CORE.md
- docs/assignments/API-PUBLIC-HISTORY-REVIEW-METADATA-CORE.md
- docs/assignments/API-PUBLIC-HISTORY-PROJECTION-CORE.md
- docs/assignments/API-PUBLIC-UPDATES-READER-CORE.md
- docs/assignments/API-PUBLIC-UPDATES-PROJECTION-CORE.md
- apps/db/test/manual-publication-gate-composition.test.ts
- apps/db/src/public-event-history.ts
- apps/db/src/public-event-updates.ts

## Scope and behavior

- Add one auto-discovered test under apps/db/test using an isolated in-memory PGlite database and authored fictional records only.
- Compose the strict proposal reader, accepted manual publication gate and real SQL writer to publish an initial event and one corrected version. Reuse accepted interfaces and synthetic setup conventions; do not add production adapters or mutation routes.
- Add exact-version synthetic review metadata only inside the test database to exercise existing public read policy. Clearly state in test names/fixture comments that the reviewer IDs and decisions are fictional test data, not real moderation or authorization.
- Read the same versions using existing bounded public history readers and Layer 4 history projection, and read the committed public changes using the existing update reader/projection or page service.
- Assert event ID, version and publication timestamp match the exact written versions; each version uses only its own reviewed change type and summary; approved DTO allowlists exclude reviewer IDs and internal proposal, trace, source, evidence and moderation fields.
- Prove public claim evidence labels from moderator selection remain separate from history change type and summary.
- Use only an ephemeral signing key if the existing update page service requires it. Do not add an API route or test a real external service.
- If the manual gate cannot exercise both versions through accepted seams without production/schema/auth changes, stop and report the precise gap rather than bypassing the gate with unreviewed writes.

## Allowed paths

- apps/db/test/manual-publication-public-read-chain.test.ts
- This assignment's implementation handoff section only

Do not change production code, migrations, public contracts/OpenAPI, UI, package files, route configuration, source/provider wiring, moderator identity/authentication, other assignments, or deployment. Root owns the plan, ADRs, backlog and checkpoint.

## Acceptance and checks

- One test exercises the real publication gate and SQL writer for both the initial version and correction, then exercises exact-version history disclosure and update-feed public projections.
- Public history and update entries agree on version identity and their respective reviewed summaries; private reviewer and internal evidence/source fields remain absent from public response projections.
- No claim label is inferred from a disclosure record, and no disclosure label or summary is inferred from the claim label.
- The test database is discarded; no external or persistent live record is used.
- In WSL Ubuntu-26.04 run the focused composition test, npm run db:test, npm test, npm run typecheck, npm run build, and git diff --check <assigned-base>..HEAD.
- Commit the assigned test and handoff on the task branch in coherent descriptive commits. Do not push or merge.

## Stop conditions

Stop and report to root if accepted service seams cannot produce the initial/corrected pair, if the public projections require a contract or migration change, or if any step requires a real moderator, source rights, credentials, hosted service or new dependency. Do not bypass authorization with a production writer call outside the manual gate. Do not escalate models unless a Luna/max attempt reaches a substantive technical impasse.

## Implementation handoff

Implementation handoff:

- **Branch/worktree:** `work/PUB-01-PUBLIC-READ-CHAIN-PGLITE-CORE` at `D:\Projects\RPL\.codex-build\worktrees\pub-01-public-read-chain-pglite-core` (WSL: `/mnt/d/Projects/RPL/.codex-build/worktrees/pub-01-public-read-chain-pglite-core`)
- **Exact base:** `a30f4605a4fa29d91066797d5a81a683d0cc86bd`
- **Implementation commit:** `0cc93d6` — `test(PUB-01): exercise publication public read chain`
- **Changed paths:** `apps/db/test/manual-publication-public-read-chain.test.ts`; this assignment handoff section.
- **Behavior:** One disposable PGlite composition uses the strict stored proposal reader, accepted manual publication gate, and real SQL writer for the initial publication and a corrected version. Exact-version fictional review metadata is added only to that test database; moderator-selected claim evidence labels are asserted independently from each version's history disclosure. Existing public history and update-feed projections return matching version identities, reviewed change types and summaries while excluding reviewer IDs and private proposal, trace, source, evidence, moderation, and sequence fields.
- **Checks run in WSL Ubuntu-26.04:** `npm exec -- tsx --test apps/db/test/manual-publication-public-read-chain.test.ts` passed (3/3); `npm run db:test` passed (43/43 files); `npm test` passed (web and Worker suites, DB 43/43 files, and evaluation casebook 19/19); `npm run typecheck` passed; `npm run build` passed (Vite production build and Wrangler `--dry-run`). `git diff --check a30f4605a4fa29d91066797d5a81a683d0cc86bd..HEAD` is run after the handoff commit and its result is included in the root handoff. Runtime/dependency versions: WSL Ubuntu-26.04, Node v24.21.0, npm 11.19.0, Git 2.53.0, and lockfile `@electric-sql/pglite` 0.5.8.
- **Limitations:** Reviewer IDs, review decisions, and disclosure summaries are fictional test fixtures; this does not claim a real reviewer, identity check, or authorization. The database is ephemeral and no hosted service or real source is used.
- **Migration/configuration impact:** None. No production code, migration, public contract, route, configuration, package, or dependency changed.
- **Remaining decisions:** None. The required moderator-selected public claim labels are supplied explicitly per claim in the synthetic approval fixture, per settled ADR-052 policy.

Root independently reviews and accepts the branch.
