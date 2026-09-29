# L3-PROGRESS-FINGERPRINT-CORE handoff

Implementation is ready for root review; acceptance and final task status remain with the root reviewer.

## Branch, commits, and runtime

- Branch: work/L3-PROGRESS-FINGERPRINT-CORE
- Worktree: C:/Users/perry/.codex/worktrees/obs-01-l1-fixture-telemetry/RPL (/mnt/c/Users/perry/.codex/worktrees/obs-01-l1-fixture-telemetry/RPL in WSL)
- Base: 2caa0917f6bea29f41ea5f1d09d015c99d2654b2
- Implementation commit: 8f5f767c3569387ccaede348aa7cd22493c3fab3 - feat(L3-PROGRESS-FINGERPRINT-CORE): persist scoped progress fingerprints
- Review-fix commit: 22b70a1be61a9bb24fbf76f8a6336fdef329d8fd - fix(L3-PROGRESS-FINGERPRINT-CORE): enforce fingerprint insert and replay invariants
- Verification environment: WSL Ubuntu-26.04, Node.js 24.21.0, npm 11.19.0
- package-lock.json SHA-256 at start: 1b9e33294c14791501eb404f4224e6a9ed0e4207eda40f9ad495ce2c8f2e17c4
- Required Git metadata override:
  - GIT_DIR=/mnt/d/Projects/RPL/.git/worktrees/RPL4
  - GIT_WORK_TREE=/mnt/c/Users/perry/.codex/worktrees/obs-01-l1-fixture-telemetry/RPL

## Behavior delivered

Migration 019 adds an internal per-case pinned fingerprint key ID, action HMAC digest fields, and append-only progress snapshots tied to the exact dataset, investigation, checkpoint version, candidate, and context. It leaves schema-2.0 request JSON unchanged. The waspada_l3_coordinator receives column-level access only to required fields; tests retain the no-table-level-grant assertion and verify unrelated roles and the L2 reader remain denied.

The Worker fingerprint service uses injected Web Crypto HMAC-SHA-256 material, strict canonical JSON for validated registered action inputs, separate action and grounding domains, and dataset/investigation scoping. Grounding fingerprints use a closed text-free metadata projection. Free-form missing-field and conflict labels are represented only by bounded counts; their values are neither inspected nor hashed. Canonical sorting uses a locale-independent code-unit comparator. Persistence, fixtures, and errors contain only fixed identifiers, key IDs, digest bytes, and bounded status data, not raw action input, grounding text, key material, or exception details.

New cases pin the configured key ID and seed the initial grounding baseline. Exact duplicate registered tool actions fail before budget consumption, while replay of the same reservation ID remains idempotent. Grounding refresh appends a replay-safe snapshot tied to its checkpoint version, resets the no-progress counter on digest change, increments it on an unchanged digest, and stops after two successive no-progress refreshes. A reserved but unstarted action keeps its reservation and counters across refresh; a started action blocks refresh. Database INSERT validation requires fingerprints for tool reservations while allowing reasoning reservations with null fingerprints. Legacy null-fingerprint tool reservations can still take allowed status transitions. Resume with a context ID remains paused-only for a new checkpoint, while exact same-version replay is idempotent.

## Changed paths

- apps/db/migrations/019_l3_progress_fingerprints.sql
- apps/db/src/investigation-ledger.ts
- apps/db/test/investigation-ledger.test.ts
- apps/db/test/migrations.test.ts
- apps/db/test/public-event-updates.test.ts
- apps/worker/src/layers/l3-investigation/entry.ts
- apps/worker/src/layers/l3-investigation/progress-fingerprint.ts
- apps/worker/src/layers/l3-investigation/reasoning-step-executor.ts
- apps/worker/src/layers/l3-investigation/single-step-executor.ts
- apps/worker/src/layers/l3-investigation/telemetry.ts
- apps/worker/test/l3-insufficient-context-entry.test.ts
- apps/worker/test/l3-investigation-telemetry.test.ts
- apps/worker/test/l3-progress-fingerprint.test.ts
- apps/worker/test/l3-reasoning-step-executor.test.ts
- apps/worker/test/l3-single-step-executor.test.ts
- docs/assignments/L3-PROGRESS-FINGERPRINT-CORE-HANDOFF.md

## Verification

All commands ran in WSL Ubuntu-26.04 from the assigned worktree with the pinned Node/npm runtime above.

- node --import tsx --test apps/worker/test/l3-progress-fingerprint.test.ts apps/worker/test/l3-insufficient-context-entry.test.ts - passed, 16/16 tests.
- node --import tsx --test apps/db/test/investigation-ledger.test.ts apps/db/test/migrations.test.ts - passed, 21/21 tests.
- npm run db:test - passed, all 21 sequential DB test files.
- npm test - passed; web tests 60/60, Worker workspace tests 328/328, all 21 DB files, and evaluation casebook 12/12.
- npm run typecheck - passed for web, Worker, DB, and evaluation TypeScript projects.
- npm run build - passed after review fixes; this runs typecheck, the Vite web production build, and the Worker Wrangler dry-run.
- git diff --check 2caa0917f6bea29f41ea5f1d09d015c99d2654b2 - passed after review fixes.

Early focused DB iterations caught a transform quoting error and a refresh rule that incorrectly blocked a reserved but unstarted action; both were fixed, preserving ADR-014 reservation behavior. The first aggregate DB run exposed the new coordinator grants in the least-privilege matrix and a public-update fixture that had not excluded migration 019 while staging its pre-016 schema. Grants were narrowed to the required snapshot columns, no-table-grant and L2 denial assertions were retained, and the fixture now stages through 015 before applying 016-019 in order. Root review then found and fixed the INSERT-trigger gap, free-form context-label rejection, locale-dependent ordering, and weakened resume state semantics. Focused and final aggregate reruns passed.

## Migration, configuration, and limits

Migration impact is additive and internal. No package dependency, lockfile, Worker binding, deployment, or public schema change was made. Existing records remain valid with a null fingerprint key; such legacy cases fail closed for autonomous fingerprinting. No hosted database or runtime secrets were configured.

PGlite and local Worker tests do not verify hosted Neon behavior, production key provisioning or rotation, or Cloudflare runtime secret delivery. This slice does not implement the coordinator loop, source acquisition, or publication authorization. Root review and integration remain outstanding.
