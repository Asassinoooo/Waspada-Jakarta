# OBS-01-FRESHNESS-DUE-TELEMETRY-CORE handoff

**Status:** Implementation complete; awaiting root review and acceptance.<br>
**Backlog ID:** `OBS-01-FRESHNESS-DUE-TELEMETRY-CORE`<br>
**Branch:** `work/OBS-01-FRESHNESS-DUE-TELEMETRY-CORE`<br>
**Worktree:** `C:\Users\perry\.codex\worktrees\obs-01-freshness-due-telemetry-core\RPL` (`/mnt/c/Users/perry/.codex/worktrees/obs-01-freshness-due-telemetry-core/RPL` in WSL)<br>
**Assigned base used:** `1bddab5073df9667dfa4fe6b42d638304202ad42`<br>
**Implementation commit:** `3dbec2dee0c873c87e013caee8172810e76d1403` — `feat(OBS-01): instrument freshness due schedule telemetry`

## Implementation

The active freshness due runtime emits at most one closed `freshness_due_schedule` event per `schedule()` invocation. Its bounded outcomes are `completed`, `failed`, and `terminal_replay`; each record has a finite nonnegative `durationMs`. Completed events contain the evaluator's validated five-counter summary. Failed events include that summary only when the evaluator returned a valid result; terminal replays and failures without a valid evaluator result contain no counts.

The existing telemetry union and console serializer now validate an exact event/count shape. Counts are safe integers from 0 through 100 and their total cannot exceed 100. The console serializer writes only the event name, outcome, duration, and validated counts in a fixed structured shape. Schedule/run IDs, timestamps, event/impact/source/evidence identifiers, content, connection values, and errors cannot enter that output.

The runtime defaults to `noOpTelemetry`. The Worker scheduled composition injects the existing `consoleTelemetry` sink; disabled gates still return before creating a runtime and emit no freshness event. Duration measurement and sink calls are exception-isolated. If the telemetry clock fails, duration falls back to zero; sink or serialization failures do not change evaluator/finalizer behavior or the runtime's fixed error.

Changed paths:

- `apps/worker/src/layers/l5-evaluation-monitoring/telemetry.ts`
- `apps/worker/src/runtime/freshness-due-schedule-runtime.ts`
- `apps/worker/src/runtime/freshness-due-schedule-trigger.ts`
- `apps/worker/src/index.ts`
- `apps/worker/test/l5-freshness-due-schedule-telemetry.test.ts`
- `apps/worker/package.json` (test command entry only)
- `docs/assignments/OBS-01-FRESHNESS-DUE-TELEMETRY-CORE-HANDOFF.md`

## Verification

Checks ran in WSL Ubuntu-26.04 using existing dependencies, without installation: Node.js `v24.21.0`, npm `11.19.0`, tsx `4.23.15`, TypeScript `7.0.2`, Vite `8.3.0`, and Wrangler `4.137.0`. The temporary `node_modules` symlink to the existing root dependency directory was removed after checks.

- Focused Worker runtime and telemetry tests: passed, 20/20.
- `npm run typecheck`: passed for web, Worker, DB, and evaluation packages.
- `npm test`: passed; web 60/60, Worker 405/405, DB 30/30 files, evaluation 12/12.
- `npm run build`: passed; Vite production build and Wrangler dry-run. The dry-run showed only `DATASET_MODE="demo"`.
- Windows Git staged `git diff --check`: passed before the implementation commit.
- WSL `git -C /mnt/d/Projects/RPL diff --check 1bddab5073df9667dfa4fe6b42d638304202ad42 work/OBS-01-FRESHNESS-DUE-TELEMETRY-CORE`: passed after the implementation commit. It is rerun after the handoff commit and the result is included in the agent report.

## Scope and limitations

No database/API contract, migration, dependency, schedule, environment binding, secret, role, provider, remote sink, source access, or deployment configuration changed. The checked-in Worker remains dormant in demo mode. Tests use deterministic runtime/telemetry doubles; no live scheduled run, hosted Neon behavior, Cloudflare deployment, or remote log collection was exercised. The existing console telemetry sink is opt-in through Worker composition, with no remote collection destination configured.

No migration or deployment configuration impact. No remaining implementation decisions within the assigned scope.
