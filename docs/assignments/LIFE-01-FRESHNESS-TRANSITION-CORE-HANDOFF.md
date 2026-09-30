# LIFE-01-FRESHNESS-TRANSITION-CORE — implementation handoff

## Assignment and revision

- Assigned base: da3bba1824c55fdecd8d0f71ef1dc5c4ba5f7966
- Branch: work/LIFE-01-FRESHNESS-TRANSITION-CORE
- Worktree: C:\Users\perry\.codex\worktrees\l3-coordinator-core\RPL (WSL: /mnt/c/Users/perry/.codex/worktrees/l3-coordinator-core/RPL)
- Contract baseline: schema 2.0 Freshness/FreshnessStatus and accepted ADR-032; no contract version changes.

## Implementation

Added a pure Layer 4 evaluator for one event or impact record. It accepts the prior freshness status, explicit issuer valid-until time, review deadline, supplied evaluation time, and a boolean that only the trusted caller may set after newer applicable evidence has completed Layer 4 evaluation.

The evaluator validates a closed input shape and explicit RFC3339 timestamps, comparing offsets and fractional seconds without millisecond truncation. Issuer expiry is checked first with now greater than or equal to valid-until. Otherwise, newly evaluated applicable evidence can restore current; without that evidence, needs_update and expired remain sticky, while a current record becomes needs_update at or after its review deadline. It returns only status and a bounded reason. It does not read a clock, perform I/O, aggregate records, or alter lifecycle or publication.

## Commits and changed paths

Implementation commit:

- SHA: 745eed65d1b121d8c3cedb01114bf6f2c1370ee4
- Message: feat(LIFE-01): add deterministic freshness transition policy

Changed paths:

- apps/worker/src/layers/l4-application-integration/freshness-transition-policy.ts
- apps/worker/test/l4-freshness-transition-policy.test.ts
- apps/worker/package.json (focused test registration only)

This handoff document is committed separately with message docs(LIFE-01): record freshness transition handoff. Its resulting commit SHA is returned to the orchestrator with this handoff.

## Verification

Environment: WSL Ubuntu-26.04, Node v24.21.0, npm 11.19.0, tsx v4.23.15, TypeScript 7.0.2. The build used Vite 8.3.0 and Wrangler 4.137.0. Existing dependencies were exposed from the primary checkout with a temporary node_modules symlink during workspace checks; the symlink was removed afterward. No dependencies were installed.

- Focused policy test: export PATH=/home/perry/.nvm/versions/node/v24.21.0/bin:/mnt/d/Projects/RPL/node_modules/.bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin && cd /mnt/c/Users/perry/.codex/worktrees/l3-coordinator-core/RPL/apps/worker && tsx --test test/l4-freshness-transition-policy.test.ts — passed, 6/6.
- Full suite: export PATH=/home/perry/.nvm/versions/node/v24.21.0/bin:/mnt/d/Projects/RPL/node_modules/.bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin && cd /mnt/c/Users/perry/.codex/worktrees/l3-coordinator-core/RPL && npm test — exit 0; web 60/60, Worker 334/334, DB 21/21 files, evaluation casebook 12/12.
- Typecheck: export PATH=/home/perry/.nvm/versions/node/v24.21.0/bin:/mnt/d/Projects/RPL/node_modules/.bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin && cd /mnt/c/Users/perry/.codex/worktrees/l3-coordinator-core/RPL && npm run typecheck — exit 0 for web, Worker, DB, and evaluation.
- Build: export PATH=/home/perry/.nvm/versions/node/v24.21.0/bin:/mnt/d/Projects/RPL/node_modules/.bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin && cd /mnt/c/Users/perry/.codex/worktrees/l3-coordinator-core/RPL && npm run build — exit 0; Vite production build and Wrangler dry-run completed.
- Assigned-base whitespace check: git -C "C:\Users\perry\.codex\worktrees\l3-coordinator-core\RPL" diff --check da3bba1824c55fdecd8d0f71ef1dc5c4ba5f7966..HEAD — exit 0 after the implementation commit.

An initial full-suite invocation used a host-expanded PATH and failed before running tests with npm spawn sh ENOENT. The full suite was rerun with the explicit Linux PATH above and passed.

## Impact and remaining decisions

No dependency, configuration, migration, database, route, API, publication, scheduler, source/provider, or runtime wiring changes. The helper consumes the caller's evidence-evaluated decision and review deadline; it does not assess evidence or calculate deadlines. Event-level aggregation of claim and impact freshness remains open under ADR-032. Persistence and scheduled evaluation remain outside this assignment.
