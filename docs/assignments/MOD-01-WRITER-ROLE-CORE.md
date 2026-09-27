# MOD-01-WRITER-ROLE-CORE — least-privilege publication capability role

- **Status:** Assigned; implementation pending.
- **Backlog:** [MOD-01-WRITER-ROLE-CORE](../IMPLEMENTATION_BACKLOG.md).
- **Depends on:** MOD-01-AUTHZ-POLICY-CORE, PUB-WRITE-CORE, ADR-006, ADR-013.
- **Requirements:** FR-08/12/13; NFR-01/05/07.
- **Branch/worktree:** `work/MOD-01-WRITER-ROLE-CORE`; `C:\Users\perry\.codex\worktrees\api-geojson-route-core\RPL`.
- **Owner:** GPT-6 Luna Max implementation agent; root plans and reviews.
- **Base:** current root `main` at dispatch; exact SHA is recorded in `docs/DELIVERY_LOG.md`.

## Objective

Add a dedicated PostgreSQL `NOLOGIN`/`NOINHERIT` capability role for the existing atomic Layer 4 publication writer. Give it only the schema, exact column reads, and exact table/column inserts that the writer needs. Preserve the existing shared `waspada_l4_publication_writer` grants because accepted source-policy, trace/telemetry, queue, and projection work still uses that role. Do not wire either role to a Worker route or credential in this task.

## Read first

- `AGENTS.md`
- `SOFTWARE_DEVELOPMENT_PLAN.md`, Sections 4, 6, 7, and 10
- `docs/IMPLEMENTATION_BACKLOG.md`
- `docs/decisions/ADR-006-moderator-auth.md`
- `docs/decisions/ADR-013-publication-write-transaction.md`
- `docs/assignments/PUB-WRITE-CORE.md`
- `docs/assignments/MOD-01-AUTHZ-POLICY-CORE.md`
- `apps/db/migrations/001_foundation.sql` through `017`-sequence context
- `apps/db/migrations/005_publication_write_receipts_outbox.sql`
- `apps/db/src/publication-writer.ts`
- `apps/db/test/publication-writer.test.ts`, `apps/db/test/migrations.test.ts`, `apps/db/test/public-event-updates.test.ts`
- `apps/db/test/harness.ts`

## Required behavior

- Add one forward-only migration named `017_moderator_publication_writer_role.sql` that creates `waspada_l4_moderator_publication_writer` as `NOLOGIN`, `NOSUPERUSER`, `NOCREATEDB`, `NOCREATEROLE`, `NOINHERIT`, `NOREPLICATION`, and `NOBYPASSRLS`.
- Grant schema `USAGE`; the publication writer's exact `dataset_namespace_config` and trace-key reads; the precise proposal/evidence/geometry/version input columns currently used by `SqlPublicationWriter`; and only its exact decision/version/claim/impact/audit/receipt/outbox insert columns. Follow the writer SQL and prove the grants by executing its real success, replay, conflict, and rollback tests with `SET ROLE waspada_l4_moderator_publication_writer`.
- Deny broad reads, source-registry policy edits, trace edits/inserts, queue operations, publication updates/deletes, role membership, and login. The new role must not inherit or be made a member of `waspada_l4_publication_writer` or another capability role.
- Preserve all existing grants and callers of `waspada_l4_publication_writer`; do not revoke or migrate its source-policy, trace/audit, acquisition queue, or later public-projection privileges.
- Add migration privilege assertions and negative access tests. Ensure test setups that intentionally apply only pre-016 migrations exclude 017 too, so their ordering remains valid.
- Keep this database-only: no identity provider, runtime login role, role membership, route, Worker wiring, credentials, deployment configuration, public contract/DTO, dependencies, source access, or live data.
- Use authored synthetic/live-shaped fixtures only. `live` values are test namespace markers and assert no real source, reviewer, or data rights.

## Allowed paths

- `apps/db/migrations/017_moderator_publication_writer_role.sql`
- `apps/db/test/migrations.test.ts`
- `apps/db/test/public-event-updates.test.ts`
- `apps/db/test/publication-writer.test.ts`
- This assignment's implementation handoff only.

Root owns ADR updates, architecture/backlog/checkpoint acceptance, runtime wiring, identity selection, and any scope changes. If exact grants do not support a complete successful writer transaction, report the missing SQL access and stop rather than widening the role beyond the reviewed operation.

## Acceptance and checks

- Test the real publication transaction under the dedicated role, including successful writes, idempotent replay/conflict, and rollback paths.
- Assert role flags and the complete intended grant boundary. Demonstrate denied unrelated reads/writes and that existing shared-role permissions remain available to their prior accepted callers.
- In WSL Ubuntu-26.04 run `npm run db:test`, `npm test`, `npm run typecheck`, `npm run build`, and `git diff --check`. Report that PGlite cannot establish hosted PostgreSQL/Neon role semantics or runtime credentials.
- Commit each coherent implementation and handoff on this branch; do not push or merge. Leave a clean worktree and report exact branch/SHA/message, changed paths, checks, limitations, and remaining decisions.

## Implementation handoff

Root review and acceptance pending.
