# LIFE-01-FRESHNESS-LEDGER-CORE — persist version-bound freshness transitions

**Status:** Accepted on local `main` after independent root review under [ADR-038](../decisions/ADR-038-append-only-freshness-transitions.md).
**Backlog ID:** `LIFE-01-FRESHNESS-LEDGER-CORE`  
**Implementation model:** GPT-6 Luna, max reasoning  
**Branch:** `work/LIFE-01-FRESHNESS-LEDGER-CORE`  
**Worktree:** Root will create a dedicated worktree from the exact local `main` commit named in the dispatch.  
**Contract baseline:** Schema 2.0 event/impact records and current `FreshnessStatus`; no public contract change.

## Context and dependencies

Read `AGENTS.md`, `SOFTWARE_DEVELOPMENT_PLAN.md`, `ARCHITECTURE.md`, `docs/DOMAIN_MODEL.md`, `docs/IMPLEMENTATION_BACKLOG.md`, ADR-032, ADR-038, and the accepted freshness transition/aggregate assignments and handoffs before editing.

The pure Layer 4 policy already decides a single event claim-set or impact status. ADR-032 and the user-selected conservative event aggregate are accepted. User decision: record each actual status transition separately and append-only against the exact published event version and, for impacts, the exact referenced impact version. Keep published event/impact rows immutable; event freshness continues to expose aggregate status only, with its existing metadata, and each impact retains its own metadata.

This slice builds the persistence foundation only. Existing public views do not read the new ledger yet. The following projection task will overlay the latest status for the exact current version, preserve the metadata in the published record, and reapply the ADR-032 event aggregate. This task must not add a clock, scheduler, source/provider, publication, or public read runtime.

Dependencies: `LIFE-01-FRESHNESS-TRANSITION-CORE`, `LIFE-01-FRESHNESS-AGGREGATE-CORE`, `DATA-01`, `DB-TEST-RUNNER-ISOLATION`, ADR-032, and ADR-038.

## Objective

Implement a bounded Layer 4 recorder and append-only database repository for actual freshness status changes. Each transition must be attached to an exact currently published event version and target either its grouped claim set or one exact referenced impact version. The DB path must preserve idempotency, reject stale/out-of-order transitions, preserve evidence lineage, and leave immutable publication records untouched.

## Required behavior

1. Reuse `evaluateFreshnessTransition` from the existing Layer 4 policy; do not duplicate its time or status rules. The recorder has no ambient clock and accepts explicit RFC3339 evaluation time.
2. Persist only when `previousStatus` differs from the policy result. No-op evaluations return a bounded no-change result and append no row.
3. Bind rows to an existing event version that is published and is the latest version for that event. For an impact target, require the exact `(event_id, event_version, impact_id, impact_version)` reference. Reject synthetic/historical-to-live substitution and cross-dataset references.
4. Each append records exact target identity, transition sequence/expected prior status, previous and resulting status, policy reason, evaluation time, trace, stable idempotency key and request fingerprint. For `new_applicable_evidence_evaluated`, require at least one exact existing evidence-reference ID. Store reference IDs only, never report text.
5. Exact replay with the same key and fingerprint returns the original transition and links without duplicate rows. Same-key/different-payload replay and stale sequence/status fail closed. The append-only transition rows cannot be updated or deleted by application roles.
6. Preserve the base event/impact JSON byte-for-byte. Do not modify lifecycle, source health, publication state, claim freshness fields, event metadata (`evaluated_at`, `review_due_at`, `basis`), or impact metadata.
7. Add a dedicated narrow `NOLOGIN`/`NOINHERIT` capability as needed. Prove the writer can append only the intended transition/link rows and cannot rewrite event versions or publication state; public, L1, and L2 roles cannot read or mutate the private ledger directly.
8. Test only isolated synthetic PGlite fixtures. Do not create a publication decision or outbox row, contact a source/provider, or imply the fixture is a real evaluation. Exact-version status reads may be exposed inside the repository for the future projection task; do not change current public views or DTOs.

## Allowed paths

- `apps/db/migrations/024_freshness_transition_ledger.sql` (new)
- `apps/db/src/freshness-transition-ledger.ts` (new)
- `apps/db/test/freshness-transition-ledger.test.ts` (new)
- `apps/db/test/migrations.test.ts` (migration ordering/inventory and capability checks only)
- `apps/db/test/public-event-updates.test.ts` (root-authorized migration-024 ordering fixture only)
- `apps/worker/src/layers/l4-application-integration/freshness-transition-recorder.ts` (new)
- `apps/worker/test/l4-freshness-transition-recorder.test.ts` (new)
- `apps/worker/package.json` (only to register the focused test; no dependency changes)
- `docs/assignments/LIFE-01-FRESHNESS-LEDGER-CORE-HANDOFF.md` (new)

Do not change public projection SQL, current public event/impact readers, API/OpenAPI/DTOs, UI, contracts, publication policy/writer, source adapters, model providers, queue/scheduler, outbox delivery, environment bindings, deployment configuration, dependencies, or unrelated migration/test files. Root authorized the one staged migration-order fixture update in `apps/db/test/public-event-updates.test.ts`; no other path was added. Synthetic publication-decision rows in PGlite fixtures only satisfy the existing immutable event-version foreign key; the recorder and repository do not create decisions or outbox rows.

## Acceptance and verification

- PGlite tests cover initial event and impact transitions, exact-version and current-published guards, impact-reference binding, evidence-link requirements for return to `current`, no-op, exact replay, conflicting idempotency reuse, stale/out-of-order sequence, append-only denial, and unchanged event/impact/publication/outbox rows and record JSON.
- Layer 4 tests cover each policy reason and show only actual status changes are sent to persistence; invalid inputs remain stable and redacted.
- Migration tests verify migration 024 ordering and least-privilege role grants, including denial of direct access for public/L1/L2 roles and update/delete for the recorder role.
- No public projection reads the new table yet; no claim-level freshness or status metadata is introduced.
- Run in WSL Ubuntu-26.04 with the existing dependency tree: focused recorder and DB tests, `npm run db:test`, `npm test`, `npm run typecheck`, `npm run build`, and `git diff --check <assigned-base>..HEAD`. Record exact results, suite counts, and Node/npm/tool versions. Do not install dependencies or contact external services.
- Implementation and handoff must be committed separately on the assigned branch. Root independently reviews and integrates accepted commits; the agent does not merge or push.

## Stop conditions

Stop and ask root if an existing schema cannot bind a transition to the exact published event/impact version, if evidence lineage cannot be preserved with reference IDs, or if correctness requires changing public event/impact metadata, DTOs, publication policy, scheduler, or source data. Do not add a public reader overlay in this assignment; that is a separate bounded task.
