# Waspada Jakarta — Current Checkpoint

**Checkpoint date:** 25 September 2026
**Reason:** PUB-WRITE-CORE is accepted as a local synthetic implementation; GEO-STORE-CORE is the next local slice. Source/data rights, MOD-01 authorization, a dedicated runtime role and hosted Neon behavior remain pending.
**Repository:** `D:\Projects\RPL`
**Remote:** `origin` → `https://github.com/Asassinoooo/Waspada-Jakarta.git`

## Repository state

Local `main` includes root-reviewed EVAL-01-TOOLS at merge `9f80600`, API-PROJECT-CORE at root integration commits `c383faa` and `249c5e2`, and PUB-WRITE-CORE at merge `b2fb994`. The accepted project work includes BOOT-01, UI-00, PLATFORM-01, DATA-01, ING-PARSE-01, L2-ADAPTER-01, JOB-01, DATA-02-CORE, RAG-CORE, RAG-ACCESS-01, PUB-POLICY-CORE, API-PROJECT-CORE, PUB-WRITE-CORE, and the synthetic-only casebook contract/validator. EVAL-01 real case collection remains planned because source/data rights are pending. Perry Tjahya and Jesaya Hamonangan Gaudensius Malau are identified as future independent reviewers; no human labels were created. Implemented fixtures remain synthetic, and historical/synthetic datasets cannot receive publishable policy dispositions.

## Latest work and files

### GEO-STORE-CORE — assigned

This local-only task adds the missing typed L1 persistence operation for source-backed geometry. It is constrained to exact CRS84 geometry storage and persisted `supports` references, with a narrow L1 role grant and PGlite tests. No geometry is geocoded, expanded into a danger area, published, or treated as semantically verified. Fixtures remain synthetic; source rights are unchanged.

### API-PROJECT-CORE — accepted

Root reviewed and merged the pure Layer 4 public projection from `work/API-PROJECT-CORE`. It validates the consumed fields of schema 2.0 event/impact inputs, resolves names and explicitly rights-approved source attributions, matches exact event/impact versions, and creates the existing public `EventView` using a field allowlist. Adversarial synthetic tests verify private metadata is stripped, failures are bounded, source publication/observation times remain distinct, and schema-valid mixed date/date-time ranges remain unmodified. This does not wire a database reader or route. Source/data rights remain pending.

Root independently passed WSL Ubuntu-26.04 `npm test` (5 web, 52 Worker, 40 DB, 12 evaluation; 109 total), `npm run typecheck`, `npm run build` (Vite and Wrangler dry-run), and `git diff main...work/API-PROJECT-CORE --check` on the final branch.

### PUB-WRITE-CORE — accepted

Root reviewed and merged `work/PUB-WRITE-CORE` at `b2fb994`, from implementation commit `3889e75` and handoff commit `cc7a51b`. It adds a transaction-scoped Layer 4 writer and migration 005 for explicitly approved event/impact versions. The writer checks the configured live namespace, current event and impact versions, proposal/evidence lineage, origin and source-supported geometry, then atomically appends decisions, immutable versions and relations, audit, a dataset-scoped receipt and a payload-minimal outbox. Stable replays/conflicts, concurrent creates, role restrictions and rollback are covered by authored synthetic/live-shaped tests. It adds no route, authentication or source integration.

Root independently passed WSL Ubuntu-26.04 checks with Node.js `v24.21.0` and npm `11.19.0`: `npm run db:test` 50/50; `npm test` 119/119 (web 5, Worker 52, DB 50, evaluation 12); `npm run typecheck`; `npm run build` (Vite and Wrangler dry-run); and `git diff main...HEAD --check`. The linked-worktree Git check required explicit `GIT_DIR` and `GIT_WORK_TREE` because its `.git` pointer contains a Windows path. PGlite does not verify hosted Neon transaction/concurrency behavior.

### EVAL-01-TOOLS — accepted

The implementation branch `work/EVAL-01-tools` was accepted into `main` at `9f80600`. It adds `docs/evaluation/CASEBOOK.md`, `docs/evaluation/casebook.schema.json`, the authored synthetic fixture, and the standalone validator/tests under `tools/evaluation/`; root recorded the assignment status in `docs/assignments/EVAL-01-TOOLS.md`, updated the backlog and delivery log, and refreshed this checkpoint. The format is metadata-only, rejects live data and split leakage, separates reviewer records from adjudication, and checks all ten category and four scenario coverage gates. These rules prepare future evaluation but do not assert real source rights or labels.

Root independently ran the final integrated tree in WSL Ubuntu-26.04 using native Linux Node.js `v24.21.0` and npm `11.19.0`. `npm test` passed 100/100 (web 5, Worker 43, DB 40, casebook 12); `npm run typecheck`, `npm run build` (Vite production build and Wrangler dry-run), and `git diff --check` passed. Source/data rights remain pending; no real incident records or human judgments were used.

JOB-01 (`work/JOB-01-durable-queue` at `6d92eb0`) was reviewed and merged as `0d49f9e`. It adds `apps/db/migrations/002_acquisition_jobs.sql`, `apps/db/src/queue.ts`, acquisition-queue ports, migration/queue tests, and the JOB-01 handoff. The queue enforces dataset-scoped idempotency, source eligibility, finite lease/attempt/retry rules, recovery, restricted L4 enqueue privileges, and source-health-only updates. Root also made Worker test discovery explicit in `apps/worker/package.json` and removed the test side-effect import from `apps/worker/test/api.test.ts` (`3a40f60`), so API, parser, and L2 suites run once each.

Root ran `npm run db:test` on the final JOB-01 branch (21/21), then `npm test` on merged `main` (47/47: web 5, Worker 21, database 21), `npm run typecheck`, and `npm run build` in WSL Ubuntu-26.04 using Node.js `v24.21.0` / npm `11.19.0`. Vite and Wrangler dry-run passed. The root WSL checkout needed the documented `npm ci --offline --no-audit --no-fund` install (88 packages); the lockfile remained unchanged. Repository `git diff --check` passed. No route changed, so no smoke test was needed.

Root updated `docs/assignments/JOB-01.md`, `docs/IMPLEMENTATION_BACKLOG.md`, `docs/DELIVERY_LOG.md`, and the checkpoint to record acceptance. It then defined DATA-02-CORE (`87452c8`) as a synthetic-only L1 text preparation and chunk-persistence slice and defined RAG-CORE (`4e1531b`) as a separate deterministic retrieval boundary. Both planning commits are on `origin/main`. No live source, provider, model, cloud account, paid service, or deployment was used.

DATA-02-CORE was implemented on `work/DATA-02-core-text-pipeline` in `.codex-build/worktrees/data-02-core`; root reviewed and merged it as `31bf43e`. The implementation adds versioned text normalization, scoped contact redaction, deterministic evidence chunking, metadata-only persistence and invalidation, and the narrowly approved column-level L1 reads in migration 003. Root independently ran WSL Ubuntu-26.04 checks on merged `main` with Node.js `v24.21.0` / npm `11.19.0`: database tests 27/27, all workspace tests 57/57 (web 5, Worker 25, database 27), typecheck, Vite production build, Wrangler deploy dry-run, and `git diff --check` all passed. The accepted handoff and limits are in `docs/assignments/DATA-02-CORE.md` and `docs/DELIVERY_LOG.md`.

## Limits and next work

- API-PROJECT-CORE is accepted as a pure Layer 4 whitelist projector. The existing database `public_event_*` views still expose full internal schema 2.0 `record_json`; no view output can be serialized directly as `EventView`. ADR-012 records the boundary; API-01 still needs database/read-role wiring and route composition.
- `PUB-WRITE-CORE` is accepted for local persistence only. Before an HTTP route uses it, MOD-01 must provide authenticated reviewer authorization and the shared L4 role must be replaced by a dedicated narrower runtime role. Source/data rights and hosted transaction behavior remain unverified.
- EVAL-01-TOOLS is accepted as local metadata validation and readiness gating only. Root independently passed `npm test` 100/100 (web 5, Worker 43, DB 40, casebook 12), `npm run typecheck`, Vite production build, and Wrangler deploy dry-run in WSL Ubuntu-26.04 with Node.js `v24.21.0` / npm `11.19.0`. The checker cannot verify external rights, reviewer identity, label truth, representativeness, or a genuine held-out freeze.
- Source/data rights remain pending, so no real incident material has been collected, retained, or labeled. The four required evaluation scenarios and ten categories are coverage gates, not claims of current data coverage.

- JOB-01 is accepted as local queue behavior. PGlite uses one in-memory database connection and cannot prove locking across concurrent PostgreSQL sessions; Neon and hosted Worker behavior remain unverified.
- DATA-02-CORE is accepted as local synthetic implementation. Pattern redaction is incomplete; PGlite does not prove Neon compatibility or concurrent locking across independent sessions; no live source, provider, or cloud behavior was exercised.
- `RAG-CORE` is accepted as a local-only Layer 2 retrieval module. Synthetic records and fixed vectors preserve provenance and contradictions, but do not prove retrieval quality or sufficiency. Its evidence-reference row cap does not guarantee a bounded physical database scan.
- `RAG-ACCESS-01` is accepted: a NOLOGIN role has only query-required column-level reads, and the real retrieval SQL passes in synthetic PGlite under `SET ROLE` across non-semantic, semantic, geometry, and combined paths. The role is not yet wired to a Worker connection or hosted Neon service.
- `PUB-POLICY-CORE` is accepted as a pure L4 assessment requiring explicit authorized moderator approval and exact evidence, source/revision/remit/freshness, source-linked geometry, and event-version checks. It performs no write or authentication; its live-only output rule holds historical and synthetic cases. Human quality evaluation and transactional rechecks remain outstanding.
- Future live operation still needs source reuse/attribution/rate/retention approval and non-empty source field mapping; human-adjudicated evaluation labels; a no-cost backup/restore/deletion path; model/provider selection and quota; basemap/geocoder/privacy terms; and measured Cloudflare/Neon behavior.
- No live-source activation, model call, cloud provisioning, paid service, or production deployment is enabled.
- RAG-CORE is accepted on `main` at merge `5e739cf`, from task head `7c6ded1` on `work/RAG-CORE-hybrid-retrieval`. Root independently ran database tests 38/38, all workspace tests 69/69 (web 5, Worker 26, database 38), typecheck, build/Wrangler dry-run, and WSL diff check.
- RAG-ACCESS-01 was implemented on `work/RAG-ACCESS-01-l2-reader` in `.codex-build/worktrees/rag-access-01` and accepted into `main`; the handoff and root review are recorded in the assignment and delivery log.
- PUB-POLICY-CORE was implemented on `work/PUB-POLICY-CORE-manual-gate` in `.codex-build/worktrees/pub-policy-core` and accepted into `main`; the branch handoff and root review are recorded in the assignment and delivery log.
- EVAL-01-TOOLS was implemented on `work/EVAL-01-tools` in `.codex-build/worktrees/eval-01-tools` and accepted into `main`; the assignment, delivery log, and synthetic fixture document its schema, leakage checks, category/scenario readiness gates, handoff, and limitations.
- The public projection boundary is recorded in `docs/decisions/ADR-012-public-projection-boundary.md`; `API-PROJECT-CORE` is assigned for a pure L4 projector with live-shaped synthetic tests and no route/database wiring.
- `API-PROJECT-CORE` is accepted on `main` at integration commits `c383faa` and `249c5e2`; the assignment, architecture and delivery log record the final branch review and independent WSL checks.
- The publication transaction boundary is recorded in ADR-013; `PUB-WRITE-CORE` is accepted on `main` at `b2fb994`, with exact commits, WSL checks and limits recorded in its assignment and the delivery log.
- The DATA-02-CORE acceptance checkpoint and docs are pushed to `origin/main` at `be4c366`. RAG-CORE's bounded design and exact implementation paths are recorded in its assignment and delivery log.

---

# Earlier Pause Checkpoint and Resumption Notes

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
| `work/PLATFORM-01-free-compatibility` | The accepted report and cadence-documentation correction at `4b4908c` are integrated; the task branch is retained clean for traceability. The merge and root review are recorded in `docs/DELIVERY_LOG.md`. |
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
- Review, test, and complete JOB-01's partial schema and repository behavior.

## Resume point

Resume with root review of JOB-01's WIP, then complete the assigned local queue behavior and WSL tests on `work/JOB-01-durable-queue`. Preserve all existing scope boundaries: no API contract change, external provisioning, live acquisition, model calls, or deployment without separate authorization.

## Autonomous development resumed — 25 September 2026

The user resumed the broader local-development goal. Root verified that `main` was clean at `da49689` and matched `origin/main`; the JOB-01 branch was clean at `0d51db0`. The interrupted Luna Max agent has been reactivated on JOB-01. No JOB-01 results are accepted yet.

Root separated deterministic fixture parsing from scheduled acquisition and human evaluation gates. The backlog now includes **ING-PARSE-01**, a local-only PetaBencana-style GeoJSON parser task that uses synthetic fixtures and requires no JOB-01 queue, EVAL-01 labels, network, persistence, or new dependency. Its scope is in `docs/assignments/ING-PARSE-01.md`. `ING-01` remains the later queue-to-L1 acquisition/activation integration and still requires its defined dependencies and source approvals.

Root also added **L2-ADAPTER-01** for strict typed classifier/extractor/embedder/reasoner contracts, evidence-bound validation, explicit no-provider behavior, and test-only doubles. It separates locally verifiable interface safety from **AI-01** provider selection and benchmarking, which still depends on human-adjudicated cases and current provider access. No model/API call is enabled.
