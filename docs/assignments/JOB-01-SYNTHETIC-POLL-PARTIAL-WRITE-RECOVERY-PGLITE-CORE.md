# JOB-01-SYNTHETIC-POLL-PARTIAL-WRITE-RECOVERY-PGLITE-CORE — verify bounded recovery after partial persistence

- **Status:** Accepted locally on `main` at root merge `d13dd4b5fa28fbfae432816258e22ee755003130`.
- **Backlog ID:** `JOB-01-SYNTHETIC-POLL-PARTIAL-WRITE-RECOVERY-PGLITE-CORE`
- **Depends on:** `JOB-01`, `JOB-01-SYNTHETIC-POLL-CLAIM-CORE`, `JOB-01-SYNTHETIC-POLL-PROCESSOR-CORE`, `JOB-01-SYNTHETIC-POLL-CYCLE-PGLITE-CORE`, `L1-WRITE-IDEMPOTENCY-CORE`, `L1-EVIDENCE-RELATION-ALIGN-CORE`, `L1-EXTRACTION-RESULT-PERSIST-CORE`, `L1-EXTRACTION-REPLAY-CORE`, `DATA-01`, `DB-TEST-RUNNER-ISOLATION`, ADR-002.
- **Requirements:** FR-02/03/13; NFR-01/05/07.
- **Architecture:** Test-only Layer 1 queue and persistence recovery composition.
- **Exact base:** `931ebef205166dd273e507ba3fe397c16309338d`.
- **Branch/worktree:** `work/JOB-01-SYNTHETIC-POLL-PARTIAL-WRITE-RECOVERY-PGLITE-CORE` at `/mnt/d/Projects/RPL/.codex-build/worktrees/job-01-synthetic-poll-partial-write-recovery-pglite-core`.
- **Contracts:** Existing source-poll job, lease/retry, synthetic fixture, report revision, evidence relation, extraction result and chunk contracts remain unchanged.

## Objective

Add a PGlite regression proving that a synthetic source-poll job can recover after it has persisted a report and one evidence reference, a later evidence write fails, and the queue failure transition itself is interrupted. Expired-lease recovery must preserve the job identity and existing rows; a fresh lease can then complete without duplicate persisted data.

## Required behavior

- Use only authored synthetic source rows, in-memory fixture content, explicit timestamps and the existing L1 role.
- On the first attempt, inject a failure after one evidence reference persists and make the first queue `fail()` transition throw. Assert the report and one reference remain, later extraction/chunk/geometry rows are absent, and the job remains leased.
- Recover the expired lease and assert retry status, preserved attempt count, new availability time, degraded source health, and unchanged source policy fields.
- Retry using a new lease token. Verify the persisted report, reference links, extraction, chunks and geometry complete exactly once, the job completes, source health records success, and the old token cannot acknowledge it.
- Keep the exactly-once limitation explicit: an extraction adapter may run again if the earlier result was not persisted.
- Assert no event version or publication was created.

## Scope

- **Allowed implementation paths:** `apps/db/test/synthetic-fixture-pipeline.test.ts` and `docs/assignments/JOB-01-SYNTHETIC-POLL-PARTIAL-WRITE-RECOVERY-PGLITE-CORE-HANDOFF.md`.
- Root owns this assignment, backlog status, architecture documents, delivery log, and checkpoint.
- No production code, migration, role/grant, public contract, dependency, source/provider integration, schedule, runtime, external service, or deployment change is allowed.

## Acceptance and verification

- One focused PGlite case covers partial writes, interrupted failure recording, exact lease expiry/recovery, replay, unique final persistence, source-health transitions, policy-field stability, stale-token denial, and zero publication writes.
- In `/mnt/d/Projects/RPL/.codex-build/worktrees/job-01-synthetic-poll-partial-write-recovery-pglite-core` under WSL Ubuntu-26.04, run `node --import tsx --test apps/db/test/synthetic-fixture-pipeline.test.ts`, `npm run db:test`, `npm test`, `npm run typecheck`, `npm run build`, and `git diff --check 931ebef205166dd273e507ba3fe397c16309338d..HEAD`, using existing Node `24.21.0` and npm `11.19.0` only. Record exact commands and outcomes in the handoff.
- Commit only the assigned test and handoff on the task branch. Do not merge or push.

## Stop conditions

Stop and report to root if correctness requires production/schema/grant/contract changes, real source access, provider calls, or hosted services. Preserve source approval and publication policies; do not alter accepted queue semantics to make the test pass. Do not escalate models without an attempted Luna/max solution and a substantive unresolved technical difficulty.

## Root review and acceptance

The implementation branch was `work/JOB-01-SYNTHETIC-POLL-PARTIAL-WRITE-RECOVERY-PGLITE-CORE`, based on `931ebef205166dd273e507ba3fe397c16309338d`, in the assigned dedicated worktree. Root integrated the branch with merge `d13dd4b5fa28fbfae432816258e22ee755003130`, preserving agent commits `1609ee83d079a1df944c383c26f21a6ffc966169` (`test(JOB-01): cover synthetic poll partial-write recovery`) and `836bc0e0126e3c1d10aec31cbf71afeb7c6bd050` (`docs(JOB-01): record partial-write recovery handoff`). The only branch paths were the allowed test and handoff.

Peer review identified two gaps that were fixed before acceptance: expired-lease recovery now runs under `waspada_l1_pipeline` with an active-role assertion, and the original token is rejected while the replacement lease is still active. Root independently passed the focused PGlite case (**1/1**), workspace typecheck, and `git diff --check 931ebef205166dd273e507ba3fe397c16309338d..HEAD` in WSL Ubuntu-26.04. The agent passed `npm run db:test` (**43/43 files**) after correcting a fixture-clock collision, and `npm test` (web/Worker, DB **43/43 files**, casebook **19/19**) before the final two test-only review assertions; after those assertions, the focused case, typecheck, build, and assigned-base diff check passed.

This verifies deterministic local queue and persistence recovery only. The extraction adapter may run again when an earlier result was not persisted, so the test does not establish exactly-once model execution. PGlite does not verify hosted Neon behavior. No production code, schema, role, grant, API, dependency, source, provider, or deployment configuration changed. See the [implementation handoff](JOB-01-SYNTHETIC-POLL-PARTIAL-WRITE-RECOVERY-PGLITE-CORE-HANDOFF.md).
