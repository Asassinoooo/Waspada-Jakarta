# DATA-01 — PostgreSQL schema, migrations and repository ports

- **Status:** In progress; no provider project or live persistence is authorized
- **Depends on:** BOOT-01, SPEC-02, PLATFORM-01
- **Requirement coverage:** FR-01/03/14; NFR-04/05/06/07/08
- **Branch/worktree:** `work/DATA-01-postgres-foundation`; `D:\Projects\RPL\.codex-build\worktrees\data-01` (`/mnt/d/Projects/RPL/.codex-build/worktrees/data-01` in WSL)
- **Owner:** GPT-6 Luna Max implementation agent; root plans and reviews

## Objective

Implement the local persistence foundation for the accepted schema 2.0. Create versioned PostgreSQL migrations with relational, spatial and vector support; define typed repository ports for source records, immutable report revisions and trace linkage; and prove database constraints with synthetic tests. PostgreSQL 18 is the target-compatible baseline, with portable SQL where practical for PostgreSQL 17. This is code and local testing only: do not create a Neon project, configure Hyperdrive, persist live-source content, or use provider secrets.

The accepted domain model remains authoritative. Translate its stored records and invariants rather than changing product states, source policies, API/OpenAPI contracts, or model behavior. Keep L1 storage/ingestion distinct from L2 retrieval, L3 investigation, and L4 publication decisions.

## Required work

- Add ordered SQL migrations and a migration ledger. Include only approved extensions `postgis` and `vector`; leave embedding dimensions/version as data rather than choosing a model or hard-coding a production vector dimension.
- Represent source registry, immutable report revisions, evidence origins/references, source-backed geometry, chunks and embedding metadata, extraction/grounding records, investigation/checkpoint budget state, proposals, immutable event/impact versions, per-claim publication decisions, and trace/audit linkage as specified in `docs/DOMAIN_MODEL.md` and `docs/contracts.schema.json`.
- Persist `dataset_kind` and prevent cross-dataset relations where database constraints allow. Use composite keys/foreign keys for dataset-scoped references; retain service-level checks for rules the database cannot establish, such as textual support, origin independence, source reuse permission and moderator authorization.
- Store geometry as PostGIS geometry in SRID 4326 with type/SRID validity checks and evidence references. Never derive buffers, danger radii or unsupported warning polygons.
- Define least-privilege database access for public read projections, L1 pipeline writes and L4 publication writes. Do not implement moderator authentication or expose mutation endpoints; MOD-01 still owns authorization.
- Define typed repository interfaces and a minimal SQL executor boundary for source registry, report revision and trace/audit writes/reads. Keep API routes on the synthetic dataset; do not wire DB reads into the public API in this task.
- Add a local in-memory PostgreSQL-compatible test harness under dev/test tooling if no suitable engine is already available in WSL. PGlite with its documented PostGIS/pgvector extensions is an allowed test-only option; it must not enter the deployed Worker bundle. If using it, record that it does not prove Neon Free behavior or exact provider extension versions.
- Use only synthetic test rows. Test migrations from an empty database, repeat/version behavior, key integrity, dataset isolation, SRID/type rejection, vector dimension metadata, trace linkage, and at least one spatial and vector query. If an invariant belongs to the application layer rather than SQL, document and test it through the repository port.

## Boundaries

- Allowed paths: `apps/db/**`; `apps/worker/src/layers/l1-data-knowledge/storage/**`; root `package.json`, `package-lock.json`, and TypeScript configuration only when needed; `REFERENCES.md` for directly used technical documentation; and this assignment's handoff section.
- Do not edit `apps/web/**`, public API/OpenAPI schemas, accepted domain contracts, source allowlists/retention policies, other ADRs, or the project plan. Ask root if a boundary change appears necessary.
- No Cloudflare/Neon account changes, provider database, Hyperdrive, credentials, live source acquisition, paid service, or deployment. No OS-level package installation; keep any test database dependency local and test-only.
- Any startup/runtime default must remain synthetic and provider-independent. No DB URL or secret may be committed.

## Acceptance and checks

- Migrations are ordered, reviewed SQL; constraints/indexes support the accepted relational, PostGIS and vector model without inventing product facts.
- A test database applies all migrations from empty state; tests cover keys, dataset separation, geometry, vector metadata and trace linkage with synthetic data.
- Repository ports are typed and do not expose raw SQL or database details to UI/API contract types. The current fixture-backed Worker/UI stays unchanged.
- Use WSL Ubuntu-26.04 with the Node/npm versions from `docs/BOOTSTRAP.md`. Run the database tests, `npm test`, `npm run typecheck`, `npm run build`, and `npm run smoke` if runtime integration changes require it. Record actual commands and results; do not claim a Neon/Hyperdrive test.
- `git diff --check` passes, changed paths stay within the allowlist, and the task branch is clean after descriptive commits.

## Handoff

### Checkpoint — incomplete

- **Branch/worktree:** `work/DATA-01-postgres-foundation` at `D:\Projects\RPL\.codex-build\worktrees\data-01` (`/mnt/d/Projects/RPL/.codex-build/worktrees/data-01` in WSL).
- **Checkpoint commit:** `wip(DATA-01): checkpoint PostgreSQL foundation`; SHA is returned to the root orchestrator after commit.
- **Changed paths:** `package.json`, `package-lock.json`, `apps/db/package.json`, `apps/db/tsconfig.json`, `apps/db/migrations/001_foundation.sql`, `apps/db/src/migrations.ts`, `apps/db/src/ports.ts`, `apps/db/src/sql.ts`, `apps/db/test/harness.ts`, `apps/db/test/migrations.test.ts`, `apps/db/test/persistence.test.ts`, and this handoff section.
- **Runtime used:** WSL Ubuntu-26.04; Node.js `v24.21.0`, npm `11.19.0`, Git `2.53.0`, using the native Node path documented by BOOT-01. The workspace adds only test tooling: [`@electric-sql/pglite@0.5.8`](https://www.npmjs.com/package/@electric-sql/pglite) (Apache-2.0 or PostgreSQL License), [`@electric-sql/pglite-postgis@0.2.8`](https://www.npmjs.com/package/@electric-sql/pglite-postgis) (Apache-2.0; explicitly experimental), and [`@electric-sql/pglite-pgvector@0.0.9`](https://www.npmjs.com/package/@electric-sql/pglite-pgvector) (Apache-2.0). Sources are the [PGlite extension docs](https://pglite.dev/extensions/) and the linked package repositories. PGlite is an in-memory test harness; its result does not prove Neon Free behavior or exact provider extension versions.
- **Migration/test strategy:** `001_foundation.sql` installs only PostGIS and pgvector, creates dataset-scoped record and relation tables, constraints, indexes, append-only protections, access roles, and a selected-dataset public projection. `src/migrations.ts` applies sorted SQL migrations transactionally, records SHA-256 checksums, skips matching applied versions, and rejects changed or missing applied versions. Tests use synthetic fixture content only.
- **SQL-enforced invariants:** dataset-scoped primary/composite foreign keys; report revision/source references; trace/dataset links; append-only report, event, impact, decision, evidence and audit records; report span and hash-shape constraints; investigation hard limits and `consumed + reserved <= limit`; paired event targets and sequential immutable event versions; same-event claim/impact support links; PostGIS geometry SRID/type/validity and evidence relations; vector run/dimension agreement without a selected production dimension; latest-published event projection with withdrawn tombstones hidden; and reader/L1/L4 privilege boundaries.
- **Repository/application checks:** the report-revision port verifies SHA-256 against the exact permitted text and checks evidence ranges using Unicode code-point offsets. Service policy still must verify source acquisition/reuse authorization, actual textual support, origin independence and relevance, moderator identity, cross-checkpoint resume continuity, and consistency between JSON payloads and normalized child rows. Required evidence-link cardinality and impact-to-claim meaning also remain service checks.
- **WSL results already observed:** native runtime version query returned Node `v24.21.0`, npm `11.19.0`, Git `2.53.0`; `npm ci --offline --no-audit --no-fund` passed (`added 88 packages in 55s`); an early `npm run db:test` against the migration suite passed 2/2; the final root `npm run db:test` completed 8/9 tests and failed only the vector-dimension ordering assertion at `apps/db/test/persistence.test.ts:197` (`actual [2,3,2]`, expected `[2,2,3]`); the root's final `npm run typecheck` passed. `npm test`, `npm run build`, `npm run smoke`, and `git diff --check` were not run after the complete test suite was added. No Neon/Hyperdrive/provider or deployment checks were run.
- **Status and remaining work:** checkpoint only; DATA-01 is incomplete and not accepted. Root review is required. The known failing test assertion and any review findings must be resolved before acceptance. No API/OpenAPI, UI, Worker runtime, provider configuration, or secrets were changed.
