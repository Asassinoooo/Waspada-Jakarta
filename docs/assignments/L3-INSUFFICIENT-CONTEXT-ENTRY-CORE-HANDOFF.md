# L3-INSUFFICIENT-CONTEXT-ENTRY-CORE implementation handoff

## Delivery

- **Branch:** `work/L3-INSUFFICIENT-CONTEXT-ENTRY-CORE`
- **Worktree:** `D:\Projects\RPL\.codex-build\worktrees\l3-insufficient-context-entry-core` (WSL: `/mnt/d/Projects/RPL/.codex-build/worktrees/l3-insufficient-context-entry-core`)
- **Implementation commit:** `9bf540736e3cbf8cc1e9e1ac73e096b124ce1fe9` — `feat(L3-INSUFFICIENT-CONTEXT-ENTRY-CORE): open cases from insufficient context`
- **Handoff commit:** recorded by the agent after committing this file.

## Behavior implemented

`createInsufficientContextEntryService` accepts the typed `InvestigationRequiredOutcome` from the L2 direct-reasoning service and delegates only to the injected ledger's `create` method. A direct-reasoning success is rejected as `review_required`. Before calling the ledger, it checks exact agreement for schema version, record type, dataset, trace, context, candidate, and sufficiency, and requires both context representations to say `sufficient: false`.

The adapter takes dataset, trace, candidate, context, question counts, and candidate-event matches from the persisted grounding record. It builds questions only from positions, with stable `missing_field_1` / `conflict_1` labels; no report, evidence, prompt, URL, or raw conflict content enters the ledger question list. Zero questions, more than 20 questions, malformed event matches, and multiple candidate-event matches return a closed `review_required` result without calling the ledger. Zero event matches map to `(null, null)`; one match maps to the exact persisted event ID/version.

The caller must supply investigation ID, requested time, policy version, and all four budget limits. The adapter does not default or adjust those values; the existing ledger remains responsible for validating the ID, time, policy, and budget maxima. Stable generated questions and passed-through caller values preserve identical create arguments on retry. The exact checkpoint returned by `ledger.create` is included unchanged in the entry result, and ledger errors propagate unchanged.

Optional write telemetry can be enabled by injecting `createTelemetryInvestigationLedgerRepository(ledger)` at composition time. The entry adapter emits no separate L3 event.

## Changed paths

- `apps/worker/src/layers/l3-investigation/entry.ts`
- `apps/worker/test/l3-insufficient-context-entry.test.ts`
- `apps/worker/package.json` — Worker test discovery only
- `docs/assignments/L3-INSUFFICIENT-CONTEXT-ENTRY-CORE-HANDOFF.md`

No database code, migration, API/schema contract, dependency, route, UI, source/provider adapter, runtime composition, or deployment behavior changed.

## Verification

Checks ran in WSL Ubuntu-26.04 using native Node.js `v24.21.0` and npm `11.19.0`; existing locked dependencies were used.

- `../../../node_modules/.bin/tsx --test apps/worker/test/l3-insufficient-context-entry.test.ts` — passed, 8/8.
- `npm test` — passed: web 5/5, Worker 101/101, database 10/10 test files (78 tests), and evaluation casebook 12/12.
- `npm run typecheck` — passed for web, Worker, database, and evaluation.
- `npm run build` — passed; typecheck, Vite 8.3.0 production build, and Wrangler 4.137.0 deploy dry-run.
- `GIT_DIR=/mnt/d/Projects/RPL/.git/worktrees/l3-insufficient-context-entry-core GIT_WORK_TREE=/mnt/d/Projects/RPL/.codex-build/worktrees/l3-insufficient-context-entry-core git diff --cached --check` and `git diff --check` — passed from WSL. Explicit worktree paths were needed because the Windows-created `.git` pointer contains a Windows path.

An initial typecheck caught a narrowed review-result return type and one unused test import. Both were corrected, and the final typecheck and full test suite passed.

## Limitations

The entry tests use synthetic schema 2.0 requests and an injected in-memory ledger fake. They verify field mapping, sufficiency/identity guards, event selection, safe bounded question labels, retries, and result/error passthrough; they do not verify PGlite transactions or hosted PostgreSQL/Neon behavior. No planner, tool executor, external source, L3 loop, model call, route, or publication behavior was added. Application/database runtime composition remains unverified. No migration or configuration change is required.
