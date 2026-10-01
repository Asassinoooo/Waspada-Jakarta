# L2-TIME-PRECISION-CORE handoff

- **Branch:** `work/L2-TIME-PRECISION-CORE`
- **Worktree:** `C:\Users\perry\.codex\worktrees\l2-time-precision-core\RPL` (`/mnt/c/Users/perry/.codex/worktrees/l2-time-precision-core/RPL`)
- **Assigned base:** `a500ecf241fb727f347557fda3fc06d5c7061de3`
- **Implementation commit:** `067a27d541ebdd97b3a68ff7e9637073ba11b540` - `fix(L2): compare event intervals at nanosecond precision`

## Changed paths

- `apps/worker/src/layers/l2-model-grounding/validation.ts`
- `apps/worker/test/l2-model-grounding.test.ts`

## Behavior

L2 interval ordering now converts validated date/time fields, fractional seconds, and signed numeric UTC offsets into integer nanoseconds before comparing them. This distinguishes all accepted one-to-nine-digit fractional values, including reversed endpoints within the same millisecond. Parsed results retain the exact input timestamp strings.

Exact and range event-time scopes still reject only when the end precedes the start, so equal offset-equivalent instants remain valid. Date-only values retain their UTC-midnight comparison. Validity periods remain end-exclusive and reject equal or reversed instants.

Synthetic regressions cover the requested `.123456Z` to `.123455Z` exact and range reversals, increasing six- and nine-digit values, offset-equivalent instants, unchanged timestamp text, date-only ordering, one-nanosecond validity ordering, equal validity boundaries, and content-free malformed-timestamp errors.

## Verification

All commands ran in WSL Ubuntu-26.04 with Node `v24.21.0` and npm `11.19.0`. A temporary `node_modules` symlink to `/mnt/d/Projects/RPL/node_modules` was removed before handoff.

- Focused L2 parser test: **7/7 passed**.
- Focused reasoning bridge test: **18/18 passed**.
- `npm test`: **passed** - web 60/60, Worker 377/377, DB 24/24 files (203 tests), evaluation 12/12.
- `npm run typecheck`: **passed**.
- `npm run build`: **passed** - Vite 8.3.0 production build and Wrangler 4.137.0 dry-run. The dry-run exposes only the existing `DATASET_MODE="demo"` binding.
- `git diff --check a500ecf241fb727f347557fda3fc06d5c7061de3..HEAD`: **passed**.

No schema, API, migration, dependency, source, provider, runtime-binding, or configuration change was made. Checks use synthetic fixtures and local PGlite; hosted Neon/Cloudflare behavior and provider behavior remain unverified. No remaining contract or design decision was identified. Root review and acceptance remain pending.
