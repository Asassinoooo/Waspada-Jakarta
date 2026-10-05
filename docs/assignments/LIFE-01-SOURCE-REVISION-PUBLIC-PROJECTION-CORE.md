# LIFE-01-SOURCE-REVISION-PUBLIC-PROJECTION-CORE — verify freshness in public projections

- **Status:** Accepted on local `main` at root merge `b5d19d68aecd5c425482b9fa1803f7d1583455d2`
- **Backlog ID:** `LIFE-01-SOURCE-REVISION-PUBLIC-PROJECTION-CORE`
- **Implementation model:** GPT-6 Luna, max reasoning
- **Branch:** `work/LIFE-01-SOURCE-REVISION-PUBLIC-PROJECTION-CORE`
- **Worktree:** `.codex-build/worktrees/life01-source-revision-public-projection-core`
- **Assigned base:** `4468117dfe3c234e803d8f2ba96133e001af689d` (`docs(DATA-02): record location matcher acceptance`); the test branch starts from this exact commit.
- **Requirements:** FR-09/10/11/13; NFR-01/05/07
- **Dependencies:** `LIFE-01-SOURCE-REVISION-WITHDRAWN-FRESHNESS-CORE`, `LIFE-01-FRESHNESS-AGGREGATE-CORE`, `API-PUBLIC-EVENT-LIST-PROJECTION-CORE`, `API-PUBLIC-DETAIL-PROJECTION-CORE`, `API-PUBLIC-HISTORY-PROJECTION-CORE`, `DB-TEST-RUNNER-ISOLATION`, ADR-042/046/048
- **Contracts:** Existing source-revision observation, freshness ledger, public `EventView`, `EventDetail`, and history DTOs; no contract change.

## Objective

Add a test-only composition proving that an explicit publisher `withdrawn` observation changes public freshness through the existing Layer 4 projections while preserving the exact published event version. The test must exercise the accepted cross-layer behavior without source access, user data, new schema, or production-code changes.

## Required behavior

1. Use only authored synthetic fixture content in an isolated local PGlite database. Create an exact report-revision observation and a still-published event with at least two impacts, where only one impact is directly supported by the withdrawn report revision.
2. Run the existing source-revision freshness transition path and feed its public-reader results into existing Layer 4 list/detail projection services. Do not duplicate transition or aggregation logic inside the test.
3. Verify the same published event version, publication identity/content, and history remain visible; the source observation must not create an event publication version or make the event itself withdrawn.
4. Verify the event-level freshness is `needs_update`, the directly affected impact is `needs_update`, and an unrelated impact keeps its prior freshness. Keep event lifecycle independent. Do not add per-claim freshness or change any public DTO.
5. Verify public projected outputs contain no source-observation IDs, private source text, report-revision internals, or freshness-ledger metadata.
6. Keep the test deterministic and isolated; it must not call the network, model providers, Cloudflare, Neon, live sources, or external tools.

## Allowed paths

- `apps/worker/test/source-revision-freshness-public-projection.test.ts` (new)
- `docs/assignments/LIFE-01-SOURCE-REVISION-PUBLIC-PROJECTION-CORE-HANDOFF.md` (new)

Do not modify production code, existing tests, migrations, repositories, contracts/OpenAPI, public routes, UI, package manifests/lockfiles, or root planning documents. If the existing public projection services cannot express the accepted policy, stop and report the smallest concrete gap rather than changing behavior or expanding scope.

## Acceptance and verification

- The focused test proves source withdrawal → freshness transition → existing public list and detail projection, immutable event publication, event/impact status separation, and metadata privacy.
- Use WSL Ubuntu-26.04 and the existing dependency tree. Record Node/npm and relevant package versions. Run the focused test directly, `npm run db:test`, `npm test`, `npm run typecheck`, `npm run build`, and `git diff --check <assigned-base>..HEAD`.
- No package installation, real source, provider, credential, external service, or deployment call is allowed.
- Work only in the assigned branch/worktree and exact pinned base. Commit the test and handoff in separate coherent commits with descriptive messages. Do not merge or push.

## Stop conditions

Stop and report if the accepted public DTO cannot represent the required event-level/impact-level distinction, if the projection would leak observation or source metadata, or if proving the behavior requires a production contract, migration, role/grant, or runtime change. Escalate only after a GPT-6 Luna/max attempt documents an unresolved substantive technical difficulty.

## Root review and acceptance

Root reviewed the two-commit branch diff from the exact assigned base and confirmed only the assigned synthetic PGlite test and handoff changed. The test uses the existing transition coordinator and existing Layer 4 list, detail, and reviewed-history projectors; it proves immutable publication/history, event-versus-impact freshness, unchanged lifecycle, unchanged claim DTOs, and private observation/source/ledger metadata. Root integrated the branch at merge `b5d19d68aecd5c425482b9fa1803f7d1583455d2`, preserving implementation commit `5f488849ffb443a9f044da727df69f7835030082` (`test(LIFE-01): verify withdrawn freshness in public projections`) and handoff commit `0f34123d381125b4bbec8c24661e9a2acc0316f6` (`docs(LIFE-01): record public projection handoff`).

The agent passed the focused test (1), `npm run db:test` (39/39 files), `npm test` (web 60/60, Worker 431/431, DB 39/39, evaluation 12/12), typecheck, build, and assigned-base diff check in WSL Ubuntu-26.04. Root independently reran the focused test (1/1) and verified assigned scope and whitespace. Only authored synthetic PGlite data was used; hosted Neon, live source providers, deployed Workers, and production data remain unverified. No dependency, migration, contract, configuration, role/grant, source, or deployment changes were made.
