# OBS-01-L3-LEDGER-TELEMETRY-CORE — implementation handoff

## Delivery

- Branch: `work/OBS-01-L3-LEDGER-TELEMETRY-CORE`
- Worktree: `D:\Projects\RPL\.codex-build\worktrees\obs-01-l3-ledger-telemetry-core`
- Base: `b874999871798765820640674cdf40f98af6204b`
- Implementation commit: `e6f39562be8dafd599ebac631d0e042793f9e3e9` — `feat(OBS-01-L3-LEDGER-TELEMETRY-CORE): add privacy-safe L3 ledger telemetry`
- The handoff is committed separately from the implementation.

## Behavior implemented

`createTelemetryInvestigationLedgerRepository` decorates the existing investigation-ledger port and defaults to `noOpTelemetry`. It instruments only `create`, `reserve_action`, `start_action`, `reconcile_action`, `reconcile_interrupted`, `release_uninvoked`, `pause`, `resume`, and `terminate`. The two reads return the underlying repository promises directly and emit no event.

Successful operations emit only the fixed operation/outcome, finite non-negative duration, closed checkpoint status and stop reason, and consumed counters. Tool attempts, reasoning turns, and model tokens must be non-negative integers; active seconds accept any finite non-negative value. Errors emit only the fixed operation/error outcome and duration. The decorator returns the exact repository result or rethrows the exact repository error. Sink exceptions are swallowed on both paths.

The typed telemetry union now includes L3 success and error records. `consoleTelemetry` serializes each event type through explicit allowlists and drops forged properties or invalid runtime discriminators. The existing API and L2 record types and valid structured output fields remain unchanged. The new focused test is registered in the Worker test script.

No investigation decisions, action execution, evidence/source behavior, DB code, migration, API/schema, Wrangler configuration, dependency, or runtime composition path changed.

## Changed paths

- `apps/worker/src/layers/l3-investigation/telemetry.ts`
- `apps/worker/src/layers/l5-evaluation-monitoring/telemetry.ts`
- `apps/worker/test/l3-investigation-telemetry.test.ts`
- `apps/worker/package.json`
- `docs/assignments/OBS-01-L3-LEDGER-TELEMETRY-CORE-HANDOFF.md`

## Verification

Commands ran in WSL Ubuntu-26.04 with Node.js `v24.21.0`, npm `11.19.0`, tsx `4.23.15`, TypeScript `7.0.2`, and Wrangler `4.137.0`, using the existing locked dependencies.

- `tsx --test apps/worker/test/l3-investigation-telemetry.test.ts apps/worker/test/api.test.ts apps/worker/test/l2-evidence-retrieval.test.ts` — passed, 17/17 tests. Coverage includes all nine write-success paths, both uninstrumented reads, result/error identity, sink failures, sensitive-marker omission, invalid summaries, fractional active seconds, and console allowlists.
- `npm run typecheck` — passed for web, Worker, database, and evaluation.
- `npm run build` — passed; Vite built production assets and Wrangler `4.137.0` accepted the Worker bundle with `--dry-run`.
- `git diff --check` — passed. The staged implementation diff also passed `git diff --cached --check`.

## Limitations

The sink remains opt-in; no Worker/database composition currently enables it. No deployment or remote log collection was performed or verified. Tests use local typed repositories and synthetic records; hosted PostgreSQL behavior was not tested. Root review and full integrated-suite verification remain outstanding.
