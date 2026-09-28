# L1-EXTRACTION-REPLAY-CORE — reuse persisted extraction on queue retries

- **Backlog ID:** `L1-EXTRACTION-REPLAY-CORE`
- **Objective:** Before invoking Layer 2 extraction for a retried synthetic L1 job, look up and reuse an exact, already-persisted candidate so an uncertain queue acknowledgement does not invoke a nondeterministic model again.
- **Dependencies:** `L1-FIXTURE-EXTRACTION-CORE`, `L1-EXTRACTION-RESULT-PERSIST-CORE`, `DB-TEST-RUNNER-ISOLATION`.
- **Requirements:** FR-03/04/05/06; NFR-01/05/07.
- **Layer:** Layer 1 result replay plus the existing Layer 2 extraction capability. This is an idempotency boundary, not an investigation or publication workflow.
- **Contract:** Preserve schema 2.0, the public API/OpenAPI contracts, and the four `EvidenceRelation` values. Add only an internal typed database lookup and its structural Worker port. Keep DB runtime dependencies out of Worker code.
- **Activation gate:** This must be accepted before any nondeterministic or live extraction provider is enabled. The existing acknowledgement-replay proof uses a deterministic synthetic provider and does not prove convergence if a provider returns different output on retry.
- **Branch/worktree:** `work/L1-EXTRACTION-REPLAY-CORE` in the reusable managed worktree `C:\Users\perry\.codex\worktrees\l1-fixture-runner-core\RPL` (WSL: `/mnt/c/Users/perry/.codex/worktrees/l1-fixture-runner-core/RPL`), based on the pushed `main` commit containing this assignment. Verify the worktree is clean and select the task branch before editing. Do not edit through the root checkout.
- **Owner:** GPT-6 Luna Max implementer; root plans, independently reviews, integrates, and pushes.

## Read first

- `AGENTS.md`
- `SOFTWARE_DEVELOPMENT_PLAN.md`, `ARCHITECTURE.md`, `docs/IMPLEMENTATION_BACKLOG.md`, and this assignment
- `docs/DOMAIN_MODEL.md` and `docs/contracts.schema.json`
- `docs/assignments/L1-EXTRACTION-RESULT-PERSIST-CORE.md` and its handoff
- `docs/assignments/L1-FIXTURE-EXTRACTION-CORE.md` and its handoff
- `apps/db/src/extraction-results.ts`, `apps/db/src/ports.ts`, migration 018, and `apps/db/test/extraction-results.test.ts`
- `apps/worker/src/layers/l1-data-knowledge/synthetic-fixture-pipeline.ts` and its Worker/PGlite tests

## Required behavior

1. Add a typed `findByCandidateId`-style operation to the extraction-result repository. Read only the existing least-privilege L1 columns from migration 018 unless a concrete missing permission is proved. Validate the stored closed schema 2.0 record and its database identity before returning it.
2. In the synthetic L1 pipeline, create-or-verify the immutable report revision first, then look up the candidate before calling `ModelCapabilityAdapter.extract`. On a miss, preserve the existing extraction path. On a hit, require exact `synthetic` dataset, caller-authored candidate ID, job trace, and report revision identity, then reuse the stored result without calling L2.
3. Persist/reverify every evidence-reference identity from the reused result, preserving all four relations, and call the existing extraction `createOrVerify` port. Keep chunk/geometry writes idempotent and acknowledge the queue only after all writes succeed.
4. Return closed fixed outcomes: a database read outage is retryable; a malformed stored row or candidate/report identity conflict is permanent and must not be treated as a provider failure. Never expose record contents, text, URLs, or raw errors.
5. An acknowledgement-recovery replay must not call the injected model adapter again, even if a test adapter would return different extraction fields on a second call. The immutable first result and exact evidence links remain the source for the replay.
6. Keep this synthetic-only. Do not add a live model/provider, source acquisition, network call, schema/API version, event, investigation, or publication behavior.

## Acceptance tests

- Database tests prove exact candidate lookup under `SET ROLE waspada_l1_pipeline`, return a closed validated record, distinguish absent rows from identity conflicts, reject corrupted/mismatched data with bounded outcomes, and retain least-privilege access.
- PGlite invokes the real L1 pipeline and accepted extraction repository. First attempt stores one candidate and four relation links but encounters an uncertain completion acknowledgement. After lease recovery, the second attempt reuses the persisted record, calls the adapter zero additional times, completes, and leaves exactly one candidate and the same four links.
- A new candidate invokes the adapter exactly once; empty input invokes it zero times. Report identity drift and malformed persisted candidates fail closed before adapter invocation. Read outages remain retryable and redacted.
- No Event, public version, publication decision, source fetch, Worker route, timer, or cloud resource is used. Hosted Neon concurrency remains explicitly unverified.

## Allowed paths

- `apps/db/src/extraction-results.ts`
- `apps/db/src/ports.ts`
- `apps/db/test/extraction-results.test.ts`
- `apps/db/test/synthetic-fixture-pipeline.test.ts`
- `apps/worker/src/layers/l1-data-knowledge/synthetic-fixture-pipeline.ts`
- `apps/worker/test/synthetic-fixture-pipeline.test.ts`
- `apps/db/migrations/019_l1_extraction_result_replay_read.sql` only if the existing least-privilege grants are insufficient; never broaden to table-level access
- This assignment's implementation handoff only

Do not modify public contracts, OpenAPI, other migration history, provider selection, prompts, dependency manifests/lockfiles, routes, queue schema, or deployment settings. Do not add dependencies or use live source/model services.

## Verification

Run sequentially in WSL Ubuntu-26.04 with Node `v24.21.0` and npm `11.19.0`; record installed versions:

- Focused: `node_modules/.bin/tsx --test apps/db/test/extraction-results.test.ts apps/worker/test/synthetic-fixture-pipeline.test.ts apps/db/test/synthetic-fixture-pipeline.test.ts`
- `npm test --workspace=@waspada/worker`
- `npm run db:test`
- `npm test`
- `npm run typecheck`
- `npm run build`
- `git diff --check`

Do not run DB suites concurrently. Use only authored synthetic fixtures and injected provider doubles. Do not claim live provider, multi-session Neon, or hosted behavior from local tests.

## Stop conditions

Stop and report the exact permission or identity-validation blocker if migration 018 cannot support an exact lookup, if the stored schema 2.0 record cannot be validated without weakening its contract, or if exact report identity cannot be verified. Do not broaden privileges or alter the public/schema contract. Escalate to GPT-6 Astra xhigh only after a GPT-6 Luna Max attempt fails on substantive technical difficulty.

## Implementation handoff

Commit implementation and the completed handoff separately on the task branch. Include the branch/worktree, implementation and handoff SHAs/messages, changed paths, exact replay behavior, actual WSL checks/results, migration/dependency/config impact, limitations, and unresolved decisions. Root independently reviews and integrates; do not merge or push.

### Completed handoff

- **Branch/worktree:** `work/L1-EXTRACTION-REPLAY-CORE` at `C:\Users\perry\.codex\worktrees\l1-fixture-runner-core\RPL` (WSL `/mnt/c/Users/perry/.codex/worktrees/l1-fixture-runner-core/RPL`), based on `1dff6a4795088b35641a6f6c58c065a587e62fb0`.
- **Implementation commit:** `e8d5f98` — `feat(l1): reuse persisted fixture extractions on retry`.
- **Handoff commit message:** `docs(l1): record extraction replay implementation handoff`. Its SHA is reported to the root with this commit because a commit cannot contain its own SHA without changing that SHA.
- **Changed paths:** `apps/db/src/extraction-results.ts`; `apps/db/test/extraction-results.test.ts`; `apps/db/test/synthetic-fixture-pipeline.test.ts`; `apps/worker/src/layers/l1-data-knowledge/synthetic-fixture-pipeline.ts`; `apps/worker/test/synthetic-fixture-pipeline.test.ts`; `apps/worker/test/synthetic-fixture-runner.test.ts` (the last path adds only the authorized deterministic `findByCandidateId` not-found mock stub; runner behavior and assertions are unchanged); this assignment file records the handoff.
- **Behavior:** The DB repository performs an exact least-privilege candidate lookup and returns only typed `found`, `not_found`, `invalid_record`, or `identity_conflict` outcomes. It validates the closed schema 2.0 JSON, persisted row identity, and exact evidence-link set. The Worker pipeline create-or-verifies the immutable report before lookup; a valid synthetic hit reuses the persisted record and evidence without calling L2, while a miss follows the existing extraction path. Read failures remain retryable; malformed stored results and report/candidate identity conflicts use fixed permanent codes. PGlite proves uncertain-ack recovery invokes the adapter once total and leaves one candidate with the original four relation links.
- **WSL verification:** Node `v24.21.0`, npm `11.19.0`. The focused command `node_modules/.bin/tsx --test apps/db/test/extraction-results.test.ts apps/worker/test/synthetic-fixture-pipeline.test.ts apps/db/test/synthetic-fixture-pipeline.test.ts` passed 28/28 after the final type correction. `npm test --workspace=@waspada/worker` passed 300/300; `npm run db:test` passed all 21 DB test files; and aggregate `npm test` exited 0 with all workspace suites passing. Final `npm run typecheck` passed. Final `npm run build` passed, including the web production build and Worker Wrangler dry-run. `git diff --check` reported no whitespace errors; Git emitted only CRLF-to-LF normalization warnings for the two DB files.
- **Migration/dependency/config impact:** No migration was needed. Existing migration 018 supplies the exact extraction-result/evidence read grants; migration 006 supplies the existing evidence-reference columns needed for verification. No dependency, lockfile, configuration, or deployment changes.
- **Limitations and remaining decisions:** Hosted Neon concurrency and live provider behavior remain unverified and out of scope. No unresolved contract or implementation decision; root review and integration remain pending.
