# LIFE-01 source revision public projection core handoff

## Delivery

- Branch: `work/LIFE-01-SOURCE-REVISION-PUBLIC-PROJECTION-CORE`
- Worktree: `/mnt/d/Projects/RPL/.codex-build/worktrees/life01-source-revision-public-projection-core`
- Assigned base: `4468117dfe3c234e803d8f2ba96133e001af689d`
- Test commit: `5f488849ffb443a9f044da727df69f7835030082` — `test(LIFE-01): verify withdrawn freshness in public projections`
- Handoff documentation is the second, separate commit; its full SHA is included in the final implementation handoff to the root reviewer.

## Changed paths

- `apps/worker/test/source-revision-freshness-public-projection.test.ts` — adds one authored-synthetic PGlite integration test.
- `docs/assignments/LIFE-01-SOURCE-REVISION-PUBLIC-PROJECTION-CORE-HANDOFF.md` — this delivery record.

No production code, existing tests, database schema or migrations, repositories, public API/OpenAPI, UI, package manifests/lockfiles, or root planning documents changed.

## Behavior verified

The test applies the existing migrations to isolated local PGlite, seeds only authored synthetic report revisions and publication data, and processes an explicit withdrawn report-revision observation through the existing Layer 4 freshness transition coordinator. It then reads the same event through the existing public list, detail, and history projection services before and after the transition.

The persisted published event version, event and impact records, publication decision, public event content, and reviewed history remain unchanged and visible. Event freshness changes to `needs_update`; only the impact directly supported by the withdrawn revision changes to `needs_update`; the unrelated impact and both lifecycles remain unchanged. The public freshness DTO and event, impact, claim, and detail DTO keys remain within their existing contracts. Claims expose no per-claim freshness. Assertions also check that observation IDs, private source text, report revision IDs and hashes, freshness reason, and ledger metadata do not appear in list, detail, or history output.

## Checks

All commands ran in WSL Ubuntu-26.04 using existing workspace dependencies. Runtime versions: Node.js `v24.21.0`, npm `11.19.0`, PGlite `0.5.8`, tsx `4.23.15`, TypeScript `7.0.2`, Vite `8.3.0`, and Wrangler `4.137.0`.

- `node_modules/.bin/tsx --test apps/worker/test/source-revision-freshness-public-projection.test.ts` — passed, 1 test.
- `npm run db:test` — passed, 39/39 test files.
- `npm test` — passed: web 60/60, Worker 431/431, DB 39/39, evaluation 12/12.
- `npm run typecheck` — passed for web, Worker, DB, and evaluation.
- `npm run build` — passed: web production build and Wrangler Worker dry-run.
- `git diff --check 4468117dfe3c234e803d8f2ba96133e001af689d..HEAD` — passed after both commits with no whitespace errors.

## Limits and remaining decisions

This verifies the accepted local projection composition against synthetic data and existing contracts. It does not exercise hosted Neon, external source providers, deployed Cloudflare Workers, or production data. No migration, runtime configuration, dependency, or contract change is required by this test. Root review and integration remain pending; the implementing agent has not self-approved or merged the branch.
