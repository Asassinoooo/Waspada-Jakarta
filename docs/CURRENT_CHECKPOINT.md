# Waspada Jakarta — Current Project Checkpoint

**Checkpoint date:** 25 September 2026
**Reason:** Work paused at the user's request.
**Repository:** `D:\Projects\RPL`
**Remote:** `origin` → `https://github.com/Asassinoooo/Waspada-Jakarta.git`

## Integrated project state

The product is a civic safety information service for Jakarta residents and visitors. It presents reported incidents and disruptions with source evidence, event and observation times, freshness, location scope, and an explicit demo/live distinction. Its architecture follows five layers: (1) data and knowledge, (2) models and grounding, (3) bounded inference and orchestration, (4) application integration and deterministic publication rules, and (5) evaluation and monitoring. Provenance, privacy, prompt-injection isolation, audit, and human review apply across the system.

The accepted local implementation includes:

- **BOOT-01:** React/TypeScript demo UI and read-only TypeScript Worker API using synthetic data.
- **UI-00:** Responsive discovery/feed/map, event detail, and read-only moderator evidence review. Map geometry is shown only when supported by a documented fixture; status, freshness, evidence, and time fields remain distinct.
- **PLATFORM-01:** Free-tier compatibility assessment, with provider behavior and backup requirements explicitly unverified.
- **DATA-01:** Local PostgreSQL-compatible schema, migration runner, repository ports, and PGlite tests for provenance, reports, traces, audit records, spatial/semantic storage, and hash lineage. This is not Worker or Neon integration.

Planning/specification files include `SOFTWARE_DEVELOPMENT_PLAN.md`, `PROJECT_PLAN.md`, `ARCHITECTURE.md`, `docs/DOMAIN_MODEL.md`, `docs/UX_API_SPEC.md`, `docs/SOURCE_FEASIBILITY.md`, `docs/PLATFORM_COMPATIBILITY.md`, the API/schema contracts, ADRs, and the implementation backlog. Detailed work history and prior verification are in `docs/DELIVERY_LOG.md`.

## Repository and branch status at pause

| Branch/worktree | State |
| --- | --- |
| `main` | At `41324d4` before this checkpoint; clean and in sync with `origin/main`. Contains accepted BOOT-01, UI-00, PLATFORM-01, and DATA-01. |
| `work/BOOT-01-runtime-skeleton` | Accepted and merged; retained clean at `21f049e`. |
| `work/UI-00-civic-interface` | Accepted and merged; retained clean at `eddb962`. |
| `work/DATA-01-postgres-foundation` | Accepted and merged; clean at `b996c72`, also pushed to its origin branch. |
| `work/PLATFORM-01-free-compatibility` | Accepted report is integrated. A later cadence-documentation correction at `4b4908c` is clean on this branch but was not merged or independently reviewed by root. |
| `work/JOB-01-durable-queue` | Local WIP commit `0d51db0` preserves the interrupted initial migration and assignment handoff. Not pushed, tested, reviewed, merged, or accepted. |

JOB-01 implementation was interrupted and its agent halted. The only implementation artifact is `apps/db/migrations/002_acquisition_jobs.sql`, an initial queue-table draft. The WIP commit also updates `docs/assignments/JOB-01.md` to record what is incomplete. Do not apply or treat this migration as accepted. No JOB-01 tests were run.

## Verification completed before this checkpoint

Runtime and database tests were run in WSL Ubuntu-26.04 using native Node.js `v24.21.0` and npm `11.19.0`:

- **BOOT-01:** `npm ci --offline --no-audit --no-fund`, smoke checks against local Vite/Worker routes, 6 tests, typecheck, production build, Wrangler dry-run, and `git diff --check` passed.
- **UI-00:** 9 tests (5 web, 4 Worker), typecheck, local smoke, production build/Wrangler dry-run, and diff check passed. Desktop and mobile screenshots were reviewed; screenshots are retained in ignored `.codex-build/ui-00-review/`.
- **PLATFORM-01:** typecheck, 9 tests, smoke, build/Wrangler dry-run, and diff check passed for the task. Root separately checked the task diff. Provider quotas, performance, Workflows, and hosted database behavior were not tested.
- **DATA-01:** root independently verified 11/11 database tests, 20/20 overall tests (5 web, 4 Worker, 11 database), typecheck, build/Wrangler dry-run, local smoke, and diff check after the accepted branch fixes.
- **Planning/contracts:** OpenAPI validation covered 16 paths/operations and 176 local references; all embedded examples and 14 synthetic domain-contract examples validated. Markdown, schema, and diff checks are recorded in the delivery log.

These checks do not cover a live source, model provider, hosted Neon database, Cloudflare deployment, or production user study. No LaTeX compiler, cloud resource, paid service, secret, or live data connector was added or enabled.

## Unresolved decisions and gates

- Obtain and document reuse, attribution, rate, and retention permission for each live source.
- Establish a no-cost encrypted backup, restore, and deletion-replay path before persisting live-source data.
- Select and evaluate the model/version and confirm any free-tier model availability; keep model access behind an adapter until then.
- Confirm basemap, geocoder, gazetteer, database-region, and privacy terms.
- Measure actual Cloudflare/Neon workloads, quotas, latency, and stop thresholds using an authorized provider setup before deployment.
- Collect user research and human-adjudicated evaluation labels; no labels or safety-coverage claims are inferred from synthetic fixtures.
- Finish moderator authentication, publication rules, incident correction/retraction propagation, ingestion, retrieval, bounded investigation, and public API work according to the backlog.
- Review, test, and complete JOB-01's partial schema and repository behavior. Separately review the unmerged PLATFORM-01 cadence-documentation correction.

## Resume point

Resume with root review of JOB-01's WIP, then complete the assigned local queue behavior and WSL tests on `work/JOB-01-durable-queue`. Preserve all existing scope boundaries: no API contract change, external provisioning, live acquisition, model calls, or deployment without separate authorization.
