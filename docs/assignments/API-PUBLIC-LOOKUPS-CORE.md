# API-PUBLIC-LOOKUPS-CORE — reviewed lookup persistence and read port

- **Status:** Assigned; local schema/repository foundation only
- **Parent work package:** API-01 — public published-event endpoints
- **Requirements:** FR-08/09/10/15; NFR-01/07
- **Dependencies:** DATA-01, API-PROJECT-CORE, ADR-012, ADR-019
- **Layer:** L4 public projection read boundary over narrowly exposed database views
- **Contract baseline:** Existing `PublicProjectionLookups` and OpenAPI `EventView`; no DTO, route, or query-contract change
- **Implementation model:** GPT-6 Luna, max reasoning
- **Branch:** `work/API-PUBLIC-LOOKUPS-CORE`
- **Worktree:** Create a dedicated managed worktree from the pushed task-assignment commit; do not edit the root checkout.
- **Owner:** Luna Max implementation agent; root plans, reviews, accepts, integrates, and pushes

## Objective

Persist and read the two reviewed lookup classes required by the existing L4 public projector: public scope names and exact-span source attributions. Add no actual source data, source-rights assertions, publication behavior, approval endpoint, or public HTTP route. This foundation must make future API-01 database reads fail closed when a reviewed lookup is absent.

## Read first

- `AGENTS.md`
- `SOFTWARE_DEVELOPMENT_PLAN.md` (first repository document), then `docs/IMPLEMENTATION_BACKLOG.md`
- `docs/decisions/ADR-012-public-projection-boundary.md` and `docs/decisions/ADR-019-public-projection-lookups.md`
- `docs/assignments/API-PROJECT-CORE.md` and `docs/assignments/PUB-WRITE-CORE.md`
- `apps/worker/src/layers/l4-application-integration/public-projection.ts`
- `apps/db/src/sql.ts`, `apps/db/src/ports.ts`, and the current migration role/view grants
- `apps/db/test/harness.ts` and the isolated DB test runner

## Required behavior

1. Add append-only, versioned review records for scope-name display labels keyed by exact entity type, entity ID, and locale. Keep the provenance reference, reviewer ID, decision reason, and review time internal. The current lookup view returns only the latest approved `id-ID` display name; later held or withdrawn decisions remove it.
2. Add append-only, versioned public-attribution decisions tied by composite foreign key to one exact `live` supporting evidence reference. Record an internal rights-basis reference and snapshot the approved public display name, HTTPS source URL, and source `published_at` / `observed_at` values. The rights basis is not returned by the public view. Only the latest approved decision appears in that view; held or revoked decisions remove it. Do not infer public permission from `source_registry.approval_status`, `reuse_basis`, model output, or event publication.
3. Expose only the exact fields required by `PublicProjectionLookups`: entity type/ID/display name and evidence revision/hash/span/offset/relation plus approved attribution display name/URL/timestamps. The first version exposes no excerpt and maps it to `excerpt_public_use_approved: false`, `excerpt: null`.
4. Grant the existing `waspada_public_reader` role SELECT on the two safe views only. It must not read source text or underlying approval records and must have no insert/update/delete privileges. Review tables remain unwritable by application roles until MOD-01 provides an authenticated writer. Tests may seed authored synthetic rows as the database owner only.
5. Add a bounded, parameterized SQL read repository for exact requested scope and support references. Sort outputs deterministically, return no row for missing/revoked lookup data so the L4 projector can fail closed, and reject malformed or over-limit query keys without leaking values.
6. Preserve strict separation of incident lifecycle, evidence status, freshness, and user relevance. A lookup withdrawal affects public display eligibility only; it cannot alter incident state or imply safety.

## Explicit boundaries

- Use only authored fictional PGlite fixtures. Do not insert or acquire real source text, source links, scope-name records, public permission decisions, or human labels.
- No public API route, live event reader, publication writer integration, moderator UI/action, authentication, automatic source access, model call, or Worker runtime binding.
- No excerpt display, geospatial boundary, geometry creation, model-confidence threshold, or new API/OpenAPI/domain contract.
- No provider provisioning, Neon connection string, Cloudflare binding, paid service, or deployment.
- Do not change API projection allowlists or route behavior. Ask root if the existing projector lookup contract is insufficient.

## Allowed paths

- `apps/db/migrations/011_public_projection_lookups.sql` (new)
- `apps/db/src/public-projection-lookups.ts` (new)
- `apps/db/test/public-projection-lookups.test.ts` (new)
- `apps/db/test/migrations.test.ts` only for focused migration/role assertions
- `apps/db/package.json` only if the existing test command needs to register the new test
- `docs/decisions/ADR-019-public-projection-lookups.md` only for a root-approved correction to this decision
- This assignment's implementation handoff only

Root owns ADR-019, the backlog, SDP, architecture, OpenAPI/domain contracts, source-rights decisions, and any runtime/API composition. Do not edit these files or broaden the task without an explicit root response.

## Acceptance and checks

- PGlite tests cover latest-approved selection, later hold/revocation, exact evidence/span/version linkage, missing and duplicate handling, immutable history, and no excerpt exposure.
- Tests prove `waspada_public_reader` can select only the safe views and cannot access raw review tables, source text, or mutate decisions. No app role gains write privileges.
- Repository tests prove exact typed allowlists, stable ordering, bounded query sizes, parameterized filtering, and empty results for missing/revoked records.
- Existing migrations remain checksum-safe and repeatable. Test-only `live`-shaped rows remain clearly marked as fictional and do not create source-rights or factuality evidence.
- In WSL Ubuntu-26.04 run focused new DB tests, `npm run db:test`, `npm test`, `npm run typecheck`, `npm run build`, and `git diff --check`; record exact tool versions and actual results.
- Commit implementation and handoff as coherent descriptive commits on the assigned branch. Leave the task worktree clean. Do not merge or push.

## Stop conditions

Stop and report if implementation requires actual source permission, a public approval writer before MOD-01, a change to the existing public DTO, direct source-text exposure, or a wider database role. GPT-6 Astra xhigh is allowed only after a substantive technical difficulty was attempted by Luna Max and remains unresolved.

## Implementation handoff

Append exact branch/worktree, commit SHAs and messages, changed paths, behavior, actual checks, limitations, migration/configuration impact, and remaining decisions. Root independently reviews and verifies before acceptance.

### Implementer handoff — 26 September 2026

- **Branch/worktree:** `work/API-PUBLIC-LOOKUPS-CORE`; Windows path `C:\Users\perry\.codex\worktrees\api-geojson-route-core\RPL`; WSL path `/mnt/c/Users/perry/.codex/worktrees/api-geojson-route-core/RPL`.
- **Implementation commit:** `535efebd52045856441a2297b24678ae0e250f75` — `feat(API-PUBLIC-LOOKUPS-CORE): add reviewed lookup storage and reader`.
- **Implementation paths:** `apps/db/migrations/011_public_projection_lookups.sql`, `apps/db/src/public-projection-lookups.ts`, `apps/db/test/public-projection-lookups.test.ts`, and `apps/db/test/migrations.test.ts` (migration registration, ordering, and count assertions only).
- **Behavior:** Added append-only scope-name and public-attribution review snapshots. The safe scope view returns the latest approved `id-ID` label; the attribution view returns only the latest approved exact live `supports` reference, its snapshotted public name/HTTPS URL/source timestamps, and `excerpt_public_use_approved: false` with `excerpt: null`. Attribution decisions use a composite foreign key over the evidence row ID and every exact evidence identity field. The public reader receives SELECT on the two new views only; application roles receive no review-table access or write grants. Added a typed, parameterized repository that resolves only exact requested keys, caps each key list at 100, omits missing or withdrawn results, sorts deterministically, and emits bounded errors without echoing query values. PGlite rows are authored synthetic fixtures; `live` markers do not assert live data, source rights, or reviewer authorization.
- **WSL tools:** Ubuntu-26.04; Node.js `v24.21.0`; npm `11.19.0`; Git `2.53.0`. Existing workspace dependencies were reused through a temporary symlink to the root `node_modules`, then the symlink was removed. No dependency or lockfile changed.
- **Checks:** `node --import tsx --test apps/db/test/public-projection-lookups.test.ts` passed 6/6. `npm run typecheck` passed. `npm run build` passed, including the Vite production build and Wrangler dry-run. `git diff --check` passed. `npm run db:test` reported 9/11 files passing, including this task's test; `grounding-contexts.test.ts` and `investigation-ledger.test.ts` fail because each still asserts migration 010 is latest after migration 011 was added. The single `npm test` run stopped with the same DB workspace failure before the evaluation casebook step. These fixed-version assertions are outside this assignment's allowed paths; root will handle them in a separate review/integration change and rerun the aggregate checks.
- **Limitations:** PGlite verifies the local schema, grants, and query behavior only. Hosted PostgreSQL/Neon behavior remains unverified. There are no real review decisions, source-rights records, source data, excerpts, approval writer, HTTP route, or Worker/database runtime wiring. MOD-01 authorization and data permissions remain prerequisites for any real approval records.
- **Migration/configuration impact:** Added forward migration `011_public_projection_lookups.sql`; no provider configuration, runtime binding, public DTO, API contract, dependency, or lockfile change.
- **Remaining decisions:** No lookup-contract gap was found. Root must correct the two existing latest-migration test expectations outside this task branch before the aggregate DB/workspace suites can pass. Real scope and attribution records remain gated on MOD-01 and source/data permissions.
