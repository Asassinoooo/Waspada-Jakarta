# L3-SYNTHETIC-L1L2-ROUNDTRIP-RESUME handoff

**Status:** Implementation complete; awaiting independent root review and integration.
**Branch:** `work/L3-SYNTHETIC-L1L2-ROUNDTRIP-RESUME`
**Worktree:** `C:\Users\perry\.codex\worktrees\l3-coordinator-core\RPL` (`/mnt/c/Users/perry/.codex/worktrees/l3-coordinator-core/RPL` in WSL Ubuntu-26.04)
**Base:** `6aa4f06b8eb86288b3d9ed6211b59aaf0e8ddda1`
**Implementation commit:** `823ae785874ddfa22b5ca18cfd21f4497e974e2d` - `test(L3-SYNTHETIC-L1L2-ROUNDTRIP-RESUME): verify persisted L1/L2 coordinator round trip`
**Handoff commit message:** `docs(L3-SYNTHETIC-L1L2-ROUNDTRIP-RESUME): record synthetic L1/L2 roundtrip resume handoff` (its SHA is reported in the task handoff because this document is part of that commit).

## Behavior

The PGlite investigation-ledger integration now drives one coordinator advance through a registered synthetic action, the existing L1 fixture runner and real SQL repositories, real L2 retrieval and exact-span rehydration, strict reasoning-context assembly, SQL context persistence, and coordinator progress recording.

The fixture seeds a valid persisted report and extraction for the same authored dataset, trace, candidate, report revision, and evidence reference before opening the investigation. That baseline satisfies the existing context foreign-key boundary. The registered action then runs the exact queued synthetic fixture through the L1 persisted-result replay path. The deterministic extractor is called only for the baseline; the L1 replay reuses the exact persisted extraction and does not call it again. The action output reference is bound to the fixture job and the exact dataset, trace, candidate, and report revision consumed by L2.

The refresh checks that identity, retrieves through the SQL evidence repository under the L2 reader role, reads the selected exact span, assembles through the existing strict validator, and persists the schema 2.0 refs-only context under the L2 writer role. Assertions cover source and revision provenance, the report/evidence hash and span offsets, distinct published/observed/retrieved/event times, context and checkpoint identity, no event/publication/proposal writes, and replay without another action, extractor call, retrieval, span read, persistence, or duplicate records. The authored fixture passes `sufficient: false` explicitly and makes no factuality or sufficiency claim.

## Changes and commits

- `apps/db/test/investigation-ledger.test.ts` - test-only L1/L2/L3 PGlite composition and exact identity, provenance, role, budget, replay, and no-publication assertions.
- `docs/assignments/L3-SYNTHETIC-L1L2-ROUNDTRIP-RESUME-HANDOFF.md` - this handoff.

No other paths are included. The implementation commit is listed above. The separate documentation commit uses the handoff commit message above; its SHA is included in the final task report.

## Verification

Commands ran in WSL Ubuntu-26.04 using the existing Linux dependency tree and Node.js `v24.21.0` from `/home/perry/.nvm/versions/node/v24.21.0/bin` (npm `11.19.0`; PGlite `0.5.8`). No dependencies were installed. The temporary `node_modules` symlink to the existing WSL dependency tree was removed before commit.

| Command | Result |
| --- | --- |
| `npm exec tsx -- --test apps/db/test/investigation-ledger.test.ts` | Passed, 12/12 tests. |
| `npm run db:test` | Passed, 21/21 DB test files. |
| `npm test` | Passed, exit 0: web workspace tests, 328/328 Worker tests, 21/21 DB files, and 12/12 evaluation tests. |
| `npm run typecheck` | Passed for web, Worker, DB, and evaluation TypeScript projects. |
| `npm run build` | Passed: typecheck, Vite production build, and Wrangler Worker dry-run. |
| `git diff --check 6aa4f06b8eb86288b3d9ed6211b59aaf0e8ddda1..HEAD` | Passed after the final handoff commit. |

## Impact and remaining decisions

No migration, schema or API contract, configuration, dependency, provider, source, production-runtime, or publication changes. MOD-01 remains read-only for the demo. Verification used local PGlite; hosted Neon behavior was not exercised. No design decision remains; root review, acceptance, and integration remain outstanding.
