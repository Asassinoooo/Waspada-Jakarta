# LIFE-01 report-revision impact reader handoff

## Assignment and branch

- Branch: work/LIFE-01-REPORT-REVISION-IMPACT-READER-CORE
- Worktree: /mnt/d/Projects/RPL/.codex-build/worktrees/life01-report-revision-impact-reader-core
- Assigned base: af38b8e3d5a50516f2de871d3d8084fffaab8eb0

## Commits

- Implementation SHA: e2b77c295a0b9ed8129a30a96891c7d33eb4afa9
- Implementation message: feat(LIFE-01): add report-revision impact reader
- Original handoff SHA: ebfaa7191c68c97edb31328739dbf89885e91eec
- Original handoff message: docs(LIFE-01): record report-revision impact reader handoff
- This correction rewrites only this handoff file. Its separate correction commit message is: docs(LIFE-01): fix handoff encoding and commit references. The correction SHA is the commit immediately after ebfaa7191c68c97edb31328739dbf89885e91eec in the branch history and is reported separately by the implementer.

## Changed paths

- apps/db/migrations/028_report_revision_impact_reader.sql
- apps/db/src/report-revision-impact-reader.ts
- apps/db/test/report-revision-impact-reader.test.ts
- apps/db/test/migrations.test.ts
- apps/db/test/public-event-updates.test.ts (staged migration inventory/order expectation only)
- docs/assignments/LIFE-01-REPORT-REVISION-IMPACT-READER-CORE-HANDOFF.md

## Behavior

The read-only reader requires an explicit dataset kind (live, historical, or synthetic), report revision ID, page size from 1 through 100, and a validated stable keyset cursor.

It matches direct evidence lineage only when the event claim evidence kind is support and the referenced evidence relation is supports for the requested report revision. It returns one event claim-set target per current published event version with at least one matching claim. An impact target additionally requires the exact impact version to be referenced by that event version and an impact_claim_support row linking that impact to a matched claim. A newer withdrawn event version hides all earlier targets. Source revision status is not checked.

Results contain dataset, event ID and version, target kind, and impact ID and version when applicable. They contain no claim IDs, evidence IDs, source text, or publication content. Public DTOs, freshness, lifecycle, history, publication, and API behavior are unchanged.

Migration 028 creates a standalone NOLOGIN NOINHERIT role named waspada_l4_report_revision_impact_reader. It removes broad privileges and role memberships, then grants schema usage and column-level SELECT only on the five lineage tables and fields used by the query. It grants no source text access or write capability. Migration tests compare existing role attributes, memberships, schema privileges, and affected table/column privileges before and after migration 028.

## Verification

Runtime: WSL Ubuntu-26.04, Node v24.21.0, npm 11.19.0. Database tests use synthetic PGlite fixtures only. No packages were installed and no external services were contacted.

- node --import tsx --test test/report-revision-impact-reader.test.ts: 6/6 passed after final reader test edits.
- node --import tsx --test test/migrations.test.ts: 13/13 passed after final migration test edits.
- node --import tsx --test test/public-event-updates.test.ts: 4/4 passed.
- npm run db:test: 33/33 DB test files passed before the last test-only assertions described below.
- npm test: passed across workspaces and 12 evaluation tests; all 33 DB test files passed in that run, before the last test-only assertions described below.
- npm run typecheck: passed after the final test edits.
- npm run build: passed, including the Vite production build and Wrangler dry-run.
- git diff --check af38b8e3d5a50516f2de871d3d8084fffaab8eb0..HEAD: passed after the original handoff commit. The range check is repeated after this correction commit.

The full DB and project suites ran before two final test-only additions: malformed-row/read-error redaction checks and impacts linked only to contradiction, context, or another report revision. Those additions passed the final focused reader test. The final migrations test also passed. Reader and migration implementation code did not change after the full suites.

## Limitations and remaining work

This is a DB reader core only. It is not wired to a runtime, API, UI, cache, vector index, moderator queue, or source/provider. No L2 retrieval or side-effecting workflow was added. Source revision state tracking and related invalidation behavior remain deferred to the assigned follow-up. A future caller must explicitly select the new capability role; migration 028 grants no membership to another role and changes no application connection configuration.

No additional policy decision is required for this slice.
