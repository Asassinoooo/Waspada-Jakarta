# JOB-01 — Durable scheduler queue and source-health tracking

- **Status:** Assigned; local synthetic implementation only
- **Depends on:** DATA-01 accepted, SPEC-01, ADR-002
- **Requirement coverage:** FR-02/13; NFR-05
- **Branch/worktree:** `work/JOB-01-durable-queue`; `D:\Projects\RPL\.codex-build\worktrees\job-01` (`/mnt/d/Projects/RPL/.codex-build/worktrees/job-01` in WSL)
- **Owner:** GPT-6 Luna Max implementation agent; root plans and reviews

## Objective

Implement the PostgreSQL-backed job ledger and typed scheduler/repository boundary needed by later fixture and source-pipeline tasks. Duplicate triggers must enqueue at most one logical job, workers must claim work under bounded leases, and failures/restarts must not lose work or reset attempts. Scheduled and moderator-submitted acquisition requests share the queue boundary and later L1 pipeline. Source health remains distinct from incident lifecycle. Use ADR-002 as the decision baseline.

## Read first

- `SOFTWARE_DEVELOPMENT_PLAN.md` — FR-02, FR-13 and NFR-05
- `docs/IMPLEMENTATION_BACKLOG.md` — JOB-01 and dependent task scopes
- `docs/DOMAIN_MODEL.md` — source approval/health and dataset rules
- `docs/decisions/ADR-002-job-queue-and-scheduler.md`
- `docs/assignments/DATA-01.md` and `apps/db/migrations/001_foundation.sql`
- `docs/PLATFORM_COMPATIBILITY.md` — documented limits and unverified provider behavior

## Required work

- Add ordered migration `002_...sql` for durable queue state. Keep `dataset_kind` boundaries, trace linkage, idempotency uniqueness, bounded attempt/lease fields, retry availability, terminal/dead-letter state, redacted failure codes and indexes for due-job claiming and source lookups.
- Add typed `apps/db` interfaces and SQL repository operations to enqueue a scheduled source poll only when its registry row is active, approved and enabled; accept a typed moderator-submission request for use by an already-authorized caller; claim one due job atomically; renew, complete and fail only with the current lease token; and recover expired leases without resetting attempts.
- Use capped exponential retry delays, a finite maximum-attempt policy, and explicit terminal status. Avoid hidden retries. Repeated failures and worker crashes count toward the same bound. The code must make stale lease acknowledgements harmless.
- Update source health only through L1-owned fields. Success updates `last_checked_at`, `last_success_at` and `healthy`; retryable errors set `degraded`; terminal/unavailable outcomes may set `unavailable` and preserve `last_success_at`. Never update event lifecycle or user-facing “safety” state from a job result.
- Keep local timers/Cron as trigger adapters only. Do not add a real Cloudflare Cron/Workflow, Neon/Hyperdrive configuration, HTTP source acquisition, report parsing, model, public route, moderator auth, secret, or live data.
- Do not change public API/OpenAPI or accepted domain contracts. Use only synthetic queue/source rows and no new dependencies unless root approves a scope issue.

## Acceptance scenarios

- A repeated enqueue with the same dataset-scoped key returns the existing logical job; different scheduled slots and different datasets remain distinct.
- Pending approved/active/enabled source polls can enqueue. Pending, suspended, paused, retired or disabled sources cannot be automatically scheduled.
- Two claimers cannot receive the same live lease. Claiming increments attempts; wrong/stale tokens cannot renew, complete or fail a job.
- A worker crash becomes recoverable after lease expiry. It re-enters retry with bounded backoff, or becomes terminal at the attempt limit; attempts never reset.
- Retryable and permanent failures take the correct path; completion is idempotent or returns a clear not-owned result without duplicating terminal effects.
- Source-health updates preserve `last_success_at` on failure and remain separate from event lifecycle. Database permissions still restrict L1 to connector health fields and L4 to source policy fields.
- Migrations apply from empty state and repeat safely with checksums; tests use the local PGlite/PostGIS/pgvector harness.

## Boundaries and checks

- **Allowed paths:** `apps/db/migrations/**`, `apps/db/src/**`, `apps/db/test/**`, root `package.json`/`package-lock.json` only if needed, and this assignment's handoff section. The root owns ADR, backlog, architecture and other plan updates.
- **Forbidden:** `apps/web/**`, Worker/API/OpenAPI contracts, source allowlists/retention policy, other ADRs, provider resources, credentials, live source reads, paid services, deployment and OS package installation.
- Use WSL Ubuntu-26.04 with native Node.js/npm from `docs/BOOTSTRAP.md`. Run `npm run db:test`, `npm test`, `npm run typecheck`, `npm run build`, and `git diff --check` from the assigned worktree. Run smoke if a runtime surface changes; this task should not change one.
- Report exact branch and commit SHAs/messages, changed paths, tests and results, migration effects, limitations, and any uncovered service checks. Leave the task branch clean after descriptive commits. Do not push or merge.

## Handoff

Implementation agent appends branch/worktree, commit SHA(s) and exact messages, changed files, behavior, actual checks, limitations and configuration impact here. Root independently reviews and records acceptance.

### User-stop checkpoint — 25 September 2026

- Work was interrupted at the user's request before implementation handoff or root review.
- Branch/worktree: `work/JOB-01-durable-queue` / `D:\Projects\RPL\.codex-build\worktrees\job-01`.
- Preserved WIP: `apps/db/migrations/002_acquisition_jobs.sql` defines an initial acquisition-job table and indexes. This migration is incomplete and unreviewed; no repository operations, typed interfaces, source-health updates, or tests were completed.
- No JOB-01 checks were run. Do not treat this migration as accepted or apply it to a database until it has been reviewed and tested.
- Open implementation checks include schema invariants and permissions against DATA-01, URL validation (HTTPS-only/no userinfo and length bound), lease/retry transitions, source-health behavior, and the complete WSL test suite.
- This checkpoint is a preservation record only; it does not change JOB-01 scope or acceptance criteria.

### Implementation handoff — 25 September 2026

- **Status:** Core implementation commits and initial local checks are agent-reported; root review is pending. A final privilege-hardening change is preserved as WIP below and has not been tested.
- **Branch/worktree:** `work/JOB-01-durable-queue` at `D:\Projects\RPL\.codex-build\worktrees\job-01` (`/mnt/d/Projects/RPL/.codex-build/worktrees/job-01` in WSL). The branch was resumed from `0d51db0` (`wip(JOB-01): checkpoint interrupted queue schema`); the draft migration was reviewed, applied from an empty PGlite database, and retained with no contract change.
- **Implementation commits:** `f4408dfa5bb1fe1d20106e8b543ea5c841ca613b` — `feat(JOB-01): add durable acquisition queue`; `6d0b765d55bc2552deffa40f7d34c9436fb099eb` — `fix(JOB-01): harden lease and health races`.
- **Changed paths:** `apps/db/migrations/002_acquisition_jobs.sql`, `apps/db/src/ports.ts`, `apps/db/src/queue.ts`, `apps/db/test/migrations.test.ts`, `apps/db/test/queue.test.ts`, and this handoff section.
- **Behavior:** Migration 002 adds dataset-scoped idempotent acquisition jobs linked to a trace and, for source polls, a registry source. It stores request metadata only, caps attempts at five, and constrains pending, leased, retry, completed and terminal states with finite UUID-token leases, redacted failure codes and due/expiry/source indexes. L1 has queue read/insert/update. The committed migration draft grants L4 table-level SELECT/INSERT, but the uncommitted WIP narrows this to SELECT plus INSERT on moderator-request columns, with database defaults fixing the job kind, status and attempt count. Public readers have no queue access. Existing source-registry column grants remain split: L1 updates connector health fields, while L4 updates source policy fields.
- **Repository behavior:** `RepositoryPorts.acquisitionJobs` exposes source-poll enqueue only for active, approved, enabled sources with a configured interval, moderator-submission enqueue, dataset-scoped idempotency, one-row atomic `FOR UPDATE SKIP LOCKED` claims, renewal/completion/failure guarded by the current token and unexpired lease, and bounded expired-lease recovery. Each claim increments the durable attempt count. Retryable failures use 30-second exponential backoff capped at 120 seconds; permanent failures and exhausted attempts become terminal. Success marks a source healthy and updates check/success timestamps; retryable failures and recovered crashes mark it degraded; terminal poll failures mark it unavailable. Health updates preserve `last_success_at` on failure and ignore older check timestamps. No event lifecycle or public safety state is written.
- **Moderator-submission boundary:** The queue validates and stores only the HTTPS URL, bounded actor ID and trace metadata. It rejects URL userinfo, fragments, credential-like query keys, whitespace and oversized values. L4 can enqueue through this port, but the port does not authenticate `requestedBy`; MOD-01 authorization must already have succeeded at the caller. Later acquisition still must check approved hosts, redirects and SSRF protections independently.
- **Agent-reported verification before the final WIP change:** WSL Ubuntu-26.04, Node.js `v24.21.0`, npm `11.19.0`; locked PGlite harness versions remain `@electric-sql/pglite 0.5.8`, `@electric-sql/pglite-postgis 0.2.8`, and `@electric-sql/pglite-pgvector 0.0.9`. `npm ci --offline --no-audit --no-fund` restored the existing lockfile dependencies (88 packages; no manifest or lockfile edits). `npm run db:test` passed 21/21; `npm test` passed all 30 tests (web 5, Worker 4, database 21); `npm run typecheck` passed; `npm run build` passed TypeScript, Vite and Wrangler deploy dry-run; and `git diff --check main...HEAD` passed. The later column-level privilege change and role test were not run through these checks. Smoke was not run because no runtime surface changed. No deployment occurred.
- **Limitations:** The PGlite harness is a single in-memory database instance without independent client sessions. `Promise.all` cases cover duplicate claim/ack and expiry/recovery ordering through the repository, but do not prove row-lock behavior under separate PostgreSQL sessions. Neon locking, provider extension versions, hosted quotas and latency remain unverified. No provider/database connection, source fetch, Cloudflare trigger, public API, model call, auth implementation, dependency change or live data was added. No migration/configuration outside the local database schema and existing role grants changed.
- **Remaining decisions:** Root review and checks of the final privilege-hardening WIP remain. True multi-session/PostgreSQL and provider validation remain for a later authorized integration task.

### User-stop checkpoint — 25 September 2026

- The user stopped active work before root review. The implementation agent was interrupted; its branch is retained without merge or push.
- The branch was at `6d0b765` when interrupted. Four paths contained uncommitted work: `apps/db/migrations/002_acquisition_jobs.sql`, `apps/db/src/queue.ts`, `apps/db/test/queue.test.ts`, and this assignment. The code narrows L4 queue insertion to moderator-submission columns and adds a `SET ROLE` test; it is unverified WIP.
- Root preserved that exact WIP in a separate checkpoint commit. It does not supersede the agent-reported results for the earlier committed revision and does not imply acceptance.
