# LIFE-01-FRESHNESS-DUE-EVALUATOR-CORE handoff

**Status:** Implementation complete; awaiting root review and acceptance.
**Branch:** `work/LIFE-01-FRESHNESS-DUE-EVALUATOR-CORE`
**Worktree:** `/mnt/c/Users/perry/.codex/worktrees/life-01-freshness-due-evaluator-core/RPL`
**Assigned base:** `5c296a30f4808ea87cb064c462773bef8d1643a7`

## Implementation

Commit `657d1a065b1b241ba3890f09192eacb20cbf527e` — `feat(LIFE-01): add bounded freshness due evaluator`.

Changed paths:

- `apps/worker/src/layers/l4-application-integration/freshness-due-evaluator.ts`
- `apps/worker/test/l4-freshness-due-evaluator.test.ts`
- `apps/worker/package.json`

The evaluator accepts an explicit dataset, RFC3339 instant, page limit from 1 through 100, optional keyset cursor, trace ID, and evaluation run ID. It reads one due-target page, validates the bounded result, and calls the existing recorder serially with the candidate's exact identity, effective status, validity/review times, sequence plus one, caller-supplied time and trace, and empty recovery evidence.

Each recorder call uses a bounded `freshness-due:` SHA-256 idempotency key over the run ID and complete dataset/event/version/target/transition-sequence identity. Written, replayed, and no-change outcomes allow processing to continue. A conflict or port failure stops the page and returns aggregate counts with the original request cursor. Successful completion returns the reader's continuation cursor. Errors and recorder details are discarded.

## Verification

Commands were run in WSL Ubuntu-26.04 with Node.js `v24.21.0` and npm `11.19.0`. Existing locked tool versions include `tsx 4.23.15`, TypeScript `7.0.2`, Vite `8.3.0`, and Wrangler `4.137.0`. No dependency was added or installed.

- Focused evaluator test: `./node_modules/.bin/tsx --test apps/worker/test/l4-freshness-due-evaluator.test.ts` — passed, 5/5.
- `npm test` — passed: web 60 tests, Worker 387 tests, DB 27/27 test files, evaluation 12 tests.
- `npm run typecheck` — passed for web, Worker, DB, and evaluation packages.
- `npm run build` — passed, including Vite production build and Wrangler Worker dry run.
- `git diff --check 5c296a30f4808ea87cb064c462773bef8d1643a7..HEAD` — passed after both implementation and handoff commits.

For these checks, the worktree temporarily linked `node_modules` to the verified existing `/mnt/d/Projects/RPL/node_modules` directory. The link was removed after verification; no dependency files changed.

## Scope and limitations

The implementation adds no database migration or grant, dependency, public contract, API route, runtime database wiring, source access, scheduler, cron trigger, model call, or publication behavior. Tests use deterministic reader and recorder fakes. Hosted Neon behavior and runtime composition remain outside this task and unverified.

No implementation decision remains open within the assigned scope. Runtime wiring and scheduling require their own assignment.
