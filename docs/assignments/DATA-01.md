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

Append the branch, commit SHAs/messages, changed files, migration/test strategy and exact WSL results. Name any test-only dependency and its license/source. List invariants covered by SQL versus repository/application validation, plus untested Neon/Hyperdrive behavior. Root records review, acceptance and the next package.
