# L3-PROGRESS-FINGERPRINT-CORE — persist privacy-safe L3 progress

**Parent package:** AGENT-01 / FR-07 bounded investigation
**Status:** Assigned on `main` after ADR-030 acceptance
**Implementation model:** GPT-6 Luna, max reasoning
**Branch:** `work/L3-PROGRESS-FINGERPRINT-CORE`
**Worktree:** Create or select a managed dedicated worktree from the assigned base; do not edit in the root checkout.
**Code baseline:** `5cbc5331cf4bee60a76011bf53cc6674f6d76897` (the root-integrated L3 PGlite verification immediately before this assignment; the implementation worktree may include only subsequent root-owned planning commits).
**Contract baseline:** L3 ledger v1 local API; schema 2.0 grounding and investigation records remain unchanged; no public API or provider/runtime configuration changes.
**Dependencies:** `L3-LEDGER-CORE`, `L3-INSUFFICIENT-CONTEXT-ENTRY-CORE`, `L3-SINGLE-STEP-EXECUTOR-CORE`, `L2-CONTEXT-PERSIST-CORE`, `L2-INVESTIGATION-PLAN-CORE`, `DB-TEST-RUNNER-ISOLATION`; [ADR-030](../decisions/ADR-030-l3-progress-fingerprints.md).

## Objective

Add the internal persistence required to stop a restarted Layer 3 coordinator from repeating an unchanged registered action or forgetting consecutive no-progress results. Store only keyed digests and bounded counters. Do not build the coordinator loop in this task.

## Allowed paths

- `apps/db/migrations/019_l3_progress_fingerprints.sql`
- Investigation-ledger repository and its focused DB tests under `apps/db/src/`, `apps/db/test/`, plus the existing migration/test registration files needed to run them
- L3 fingerprint and progress modules/tests under `apps/worker/src/layers/l3-investigation/` and focused Worker tests/scripts
- `docs/assignments/L3-PROGRESS-FINGERPRINT-CORE-HANDOFF.md`

Do not edit the root-owned SDP, architecture, backlog, ADR, checkpoint, delivery log, contracts, public schemas/OpenAPI, UI, deployment config, Wrangler bindings, secrets, package dependencies or unrelated tests. Ask root if the necessary production change falls outside these paths; continue any independent allowed work.

## Required behavior

1. Add an append-only, least-privilege internal persistence path for a per-investigation fingerprint key ID, registered-action HMAC digest, and versioned grounding-progress snapshots. Keep the public schema 2.0 JSON unchanged. A new migration must preserve prior data and must not widen unrelated database roles.
2. Implement an injected HMAC-SHA-256 fingerprint service using Web Crypto. Domain-separate action and grounding digests; scope them to dataset and investigation; canonicalize only validated typed JSON for action inputs; use a closed grounding projection as specified in ADR-030. Persist the key ID and 32-byte digest only. Never write inputs, queries, URLs, excerpts, raw context, keys or errors to SQL, logs, telemetry or fixtures.
3. Pin a key identifier per newly opened investigation. Fail closed when key configuration is absent, malformed, or does not match the case. Existing cases without a key identifier cannot be autonomously fingerprinted.
4. Prevent a second reservation for the same exact action digest in one case. The duplicate must not consume tool budget and must map to a fixed typed outcome that the later coordinator can use to stop for review. Preserve normal idempotent replay for the same reservation ID.
5. Seed a progress baseline from the initial persisted insufficient context. Append a snapshot for each refreshed context and monotonically compare it to the preceding digest: identical increments a capped consecutive no-progress count; changed resets it. Record at most the fixed stop threshold (2), bind snapshots to exact checkpoint versions, and make same-version replay idempotent. Reject cross-dataset/case/candidate context IDs, stale checkpoint updates, out-of-order timestamps/versions, malformed digests and attempts to mutate prior snapshots.
6. Keep one in-flight ledger reservation rule and all existing 5-tool / 4-reasoning / 60-second / 12,000-token caps intact. Only the L3 NOLOGIN capability may read/write new fields/tables; prove unrelated roles remain denied.

## Acceptance criteria

- PGlite tests use the real migration and repository; they cover baseline creation, progress increment/reset, same-version replay, stale/conflicting updates, exact duplicate action across separate repository instances (cold restart), normal reservation replay, bounded counters, and role-denial cases.
- Focused Worker tests prove canonical key-order invariance for closed JSON, action/grounding domain separation, dataset/case scoping, deterministic fixed-format output, missing-key fail-closed behavior, and that persisted test records contain no raw input/context or secret.
- Full aggregate DB runner stays sequential/fail-visible; no network calls or live source/provider doubles are used.
- WSL Ubuntu-26.04 commands pass: focused L3 fingerprint tests; `npm run db:test`; `npm test`; `npm run typecheck`; `npm run build`; and WSL `git diff --check` against the assigned base.
- No test may claim hosted Neon, Cloudflare secret management, production key rotation or Workflow runtime behavior was verified.

## Stop conditions and handoff

Do not configure secrets, bind or deploy Cloudflare Workflows, activate data sources, change a public contract, expand database grants beyond the assigned L3 role, or implement publication/authentication. If a cross-layer concurrency guarantee cannot be proven with the existing transactional executor, describe the failed invariant and stop before weakening it.

Commit all task work on this branch in coherent descriptive commits. Do not merge, push or edit root-owned planning files. Handoff with branch/worktree, base and full commit SHAs plus exact messages, changed paths, behavior, WSL commands/results and versions, limitations, migration/configuration impact and remaining decisions. Root owns review, integration and final status.
