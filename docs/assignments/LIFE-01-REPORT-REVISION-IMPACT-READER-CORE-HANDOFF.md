# LIFE-01 report-revision impact reader handoff

## Assignment

- Branch: `work/LIFE-01-REPORT-REVISION-IMPACT-READER-CORE`
- Worktree: `/mnt/d/Projects/RPL/.codex-build/worktrees/life01-report-revision-impact-reader-core`
- Assigned base: `af38b8e3d5a50516f2de871d3d8084fffaab8eb0`
- Implementation commit: `e2b77c2` ∫w^~)ﬁt `feat(LIFE-01): add report-revision impact reader`
- Handoff commit message: `docs(LIFE-01): record report-revision impact reader handoff` (this separate handoff commit follows the implementation commit).

## Changed paths

- `apps/db/migrations/028_report_revision_impact_reader.sql`
- `apps/db/src/report-revision-impact-reader.ts`
- `apps/db/test/report-revision-impact-reader.test.ts`
- `apps/db/test/migrations.test.ts`
- `apps/db/test/public-event-updates.test.ts` (staged migration inventory/order expectation only)
- This handoff document.

## Behavior

The bounded read-only reader requires an explicit `datasetKind` (`live`, `historical`, or `synthetic`), a report revision ID, and a page size from 1 through 100. It validates a closed request and cursor shape and uses a stable keyset ordered by event ID, event version, target kind, and exact impact identity.

It reads direct evidence lineage only. A claim matches only when its evidence link is `support` and the referenced evidence row is `supports` for the requested revision. It emits one event claim-set target for each current published event version with at least one matched claim. An impact target additionally requires an exact impact version referenced by that event version and an `impact_claim_support` row linking that target to one of the matched claims. A newer withdrawn version hides all earlier targets. Source revision status is not checked.

Results contain dataset, event ID/version, target kind, and impact ID/version where applicable. They contain no claim IDs, evidence IDs, source text, or publication content. No public DTO, freshness, lifecycle, history, publication, or API behavior changed.

Migration 028 creates standalone `NOLOGIN NOINHERIT` role `waspada_l4_report_revision_impact_reader`, revokes broad privileges and role memberships, and grants only schema usage plus column-level `SELECT` on the five lineage tables and fields required by the query. It grants no raw revision text access and no write capability. Migration tests compare existing role attributes, memberships, schema privileges, and affected table/column privileges before and after 028.

## Verification

Runtime used: WSL Ubuntu-26.04, Node `v24.21.0`, npm `11.19.0`. Tests use synthetic PGlite fixtures only; no package installation or external service access occurred.

- `node --import tsx --test test/report-revision-impact-reader.test.ts` ∫w^~)ﬁt 6/6 passed on final reader tests.
- `node --import tsx --test test/migrations.test.ts`+ßuÁ‚ùÁT 13/13 passed on final migration checks.
- `node --import tsx --test test/public-event-updates.test.ts`+ßuÁ‚ùÁT 4/4 passed.
- `npm run db:test` ∫w^~)ﬁt 33/33 DB test files passed.
- `npm test`"È›y¯ßy‘ passed across workspaces and all 12 evaluation tests; all 33 DB test files passed in that run.
- `npm run typecheck` ∫w^~)ﬁt passed after the final test edits.
- `npm run build`"È›y¯ßy‘ passed; Vite production build and Wrangler `--dry-run` both succeeded.
- `git diff --cached --check`+ßuÁ‚ùÁT passed before the implementation commit. The requested base-to-branch `git diff --check` is run after both commits.

The full DB and project suites passed before the final additional malformed-row and disallowed-lineage assertions were added. Those final test edits passed the focused reader and migration runs listed above; implementation SQL and TypeScript did not change afterward.

## Limitations and remaining work

This is a DB reader core only. It is not wired to a runtime, API, UI, cache, vector index, moderator queue, or source/provider. No L2 retrieval or side-effecting workflow was added. Source revision state tracking and its later invalidation behavior remain deferred to the assigned follow-up. A future caller must explicitly select the new capability role; migration 028 intentionally does not grant membership to another role or change application connection configuration.

No additional policy decision is required for this slice.
