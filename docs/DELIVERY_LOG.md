# Delivery log

## 24 September 2026 — development start

- User authorized proceeding with the plan and keeping agent instructions out of Git.
- `AGENTS.md` remains available locally and is ignored/untracked. Existing Git history was not rewritten.
- Root planner assigned SPEC-01 source feasibility, SPEC-02 domain/contracts and the independent portion of SPEC-03 UX/API to GPT-6 Luna subagents with max reasoning. They used disjoint paths in the shared checkout under the initial workflow; each hit the account usage limit before providing a final branch/commit handoff. Their drafts were locally reviewed and completed by root. This process exception is not being represented as compliant agent branch work, and history will not be rewritten.
- SPEC-03 API acceptance depends on the completed SPEC-02 interface; wireframe work can proceed first.
- Source probes are bounded public reads. No paid provider or deployed collector is enabled. No LaTeX work is included.
- Human interviews, source permission decisions and human adjudication of evaluation labels remain explicit outstanding work; agents cannot substitute invented findings.

Review outcomes and actual checks are appended when each work package is accepted. Planned checks are not passing results.

### SPEC-01 accepted as a design baseline

Root reviewed the source matrix, dated observations, reference entries and retention ADR. Endpoint access is distinguished from reuse permission, feed publication from event validity, and empty responses from all-clear statements. The retention policy covers derived vectors and restore-time deletion handling. Corrected the CAP specification attribution to OASIS and separated design acceptance from live-source activation. `git diff --check` passed for the implementation handoff; this documentation package has no runtime tests or implemented collector. Provider-specific permissions, current rate limits and backup arrangements remain activation gates.

### BOOT1 checkpoint — layered plan and contract review

Root summarized the checkpoint and continued without waiting for approval. The primary architecture is now framed as the five-layer system: dedicated L1 ingestion/cleaning/storage, L2 capability-specific models with spatial/semantic grounding, L3 bounded investigation only for unresolved gaps, L4 deterministic publication/application policy, and L5 evaluation/monitoring. Provenance, privacy, prompt-injection isolation, audit and human review remain cross-cutting.

**Files and artifacts changed:**

- Main plan and product alignment: `SOFTWARE_DEVELOPMENT_PLAN.md`, `PROJECT_PLAN.md`, `ARCHITECTURE.md`, `README.md`, `REFERENCES.md`, `SOURCE_VERIFICATION_PLAN.md`, and this log.
- Source/domain contracts: `docs/SOURCE_FEASIBILITY.md`, `docs/DOMAIN_MODEL.md`, `docs/contracts.schema.json`, `docs/contracts.examples.json`, and `docs/decisions/ADR-003-domain-publication-evidence.md`, `ADR-005-source-retention.md`.
- UI/API boundary: `docs/UX_API_SPEC.md`, `docs/api/openapi.yaml`, and `docs/decisions/ADR-006-moderator-auth.md`.
- Deployment/governance: `docs/decisions/ADR-001-single-server-prototype.md` (historical and superseded), `docs/decisions/ADR-010-cloudflare-neon-free.md`, `docs/decisions/README.md`, `docs/IMPLEMENTATION_BACKLOG.md`, and `docs/ARCHITECTURE_ALIGNMENT.md`.
- Local ignored `AGENTS.md` now requires a dedicated branch/worktree and descriptive commit(s) from every future implementation subagent, with Luna Max as default and Astra xhigh only for a substantive difficulty attempted but unresolved by Luna. WSL Ubuntu-26.04 is the required local project test environment. No agent commit was created for the earlier shared-checkout drafts.

**Deployment-plan changes:**

- Superseded the single-VPS/FastAPI sizing proposal; selected React/TypeScript static assets and a TypeScript Worker API, Cloudflare Workflows for bounded background tasks, Neon Free Postgres with PostGIS/pgvector, Hyperdrive, and an optional Workers AI adapter only if a Free-accessible model passes the Indonesian evaluation.
- Recorded current free quotas and fail-closed/degraded behavior. This is a low-volume class demo target, not an always-on or comprehensive Jakarta safety feed.
- Neon Free does not satisfy the previous 30-day external-backup target by itself. Until a free backup/export and deletion-replay path is tested, the plan limits persisted data to synthetic/historical demo records and blocks live-source persistence.
- Added PLATFORM-01 as a WSL-based free-tier compatibility/measurement task. No Cloudflare/Neon account, project, paid model, external service or deployment was created.

**Checks completed on WSL Ubuntu-26.04:**

- Confirmed WSL YAML and JSON Schema tooling are already available; no dependency installation was needed for this review.
- Parsed OpenAPI 3.1: 16 paths, 16 unique operations, 176 local references resolved, path parameters match their templates, and all embedded request/response examples validate against their schemas.
- Checked the JSON Schema Draft 2020-12 schema and validated all 14 synthetic contract records. All passed.
- `git diff --check` passed for tracked changes. New specification documents retain intentional two-space Markdown hard line breaks in metadata; no other trailing-whitespace finding was observed.
- No runtime application or live integration test was run; there is no implementation yet.

**Unresolved decisions:** source reuse/rate permissions; no-cost encrypted backup and deletion replay; model/version and Workers AI free-model access; map tile/gazetteer/geocoder terms; database region/privacy review; actual quota stop thresholds and warm/cold latency; human user interviews and adjudicated case labels. They do not block fixture-backed BOOT-01 implementation, but they block enabling live feeds or making a safety-coverage claim.

SPEC-02 and SPEC-03 are accepted as design baselines, not implemented services. BOOT-01 is the next ready task: implement the WSL-runnable synthetic React/Worker skeleton with mocked sources/models and no cloud credentials. PLATFORM-01 follows that runnable slice. Its implementation must use a fresh Luna Max subagent task branch/worktree and committed handoff when quota availability permits; this checkpoint itself makes no claim that BOOT-01 has started.

### SPEC-03 precision refinement and architecture collateral audit

After the BOOT-01 branch was opened, root tightened the OpenAPI public `TimeScope` projection to discriminate `exact` date-time, `date` date-only, `range`, and `unknown` null values, matching the accepted domain schema. This is committed as `af45d58` (`docs(SPEC-03): enforce time precision in API schema`). WSL revalidation passed again: 16 OpenAPI paths/operations, 176 resolved internal references, path-template parameter checks, and all embedded request/response examples; all 14 synthetic schema examples still validate.

Root text-audited the 12-slide layered kickoff deck and inspected the repository's five-layer SVG. Both keep L1 processing separate, grounding ahead of conditional L3 investigation, the shared L4 publication gate, and L5 oversight. The deck contains no superseded VPS/FastAPI deployment claim, and the SVG remains the logical architecture diagram; neither needed a content change for ADR-010.

### BOOT-01 checkpoint and UI-00 design brief — 24 September 2026

The root prepared [the UI-00 assignment](assignments/UI-00.md) from the requested frontend steer after reviewing the software development plan, backlog, and accepted UX/API specification. The brief defines a Jakarta field-atlas visual direction, six named tokens, accessible contrast pairings, four desktop/mobile/detail/moderator ASCII wireframes, demo/evidence/time rules, read-only moderator scope, and screenshot/accessibility review. UI-00 remains blocked only on the BOOT-01 runnable shell; no UI code or API-contract change was made.

Changed files: `docs/assignments/UI-00.md`, `docs/IMPLEMENTATION_BACKLOG.md`, and `REFERENCES.md`. The references register records the Anthropic frontend-design skill and Vercel web-interface checklist used. Commit `67a8bdb` (`docs(UI-00): define civic interface design brief`) passed `git diff --check`, local Markdown link validation, newline/trailing-whitespace checks in WSL, and a WSL contrast calculation. Root initialized `origin/main` by pushing the reviewed planning checkpoint; the remote had no prior branch heads. No deployment or paid service was used.

BOOT-01 remains active on `work/BOOT-01-runtime-skeleton` in its dedicated worktree. Its scaffold files are being developed, but no agent commit or runtime checks have been handed off yet. WSL can resolve npm but direct outbound HTTPS currently times out; Windows can reach the registry. The project build and verification must remain in WSL, and dependency access is unresolved. The next eligible implementation after BOOT-01 review is UI-00; EVAL-01 still requires human-adjudicated labels and is not fabricated by the team.

### BOOT-01 accepted — 24 September 2026

The root reviewed and integrated BOOT-01 from `work/BOOT-01-runtime-skeleton`. Agent commits: `1421e2497aa08c35f7d694502ab2be494b41678c` (`feat(BOOT-01): scaffold synthetic Worker demo app`) and `21f049e5c348acd7f6f0d04e77c91081fd14b304` (`docs(BOOT-01): record completed implementation handoff`). Root merge: `238128d74b8f97e24fb0392a626bf6e463c05094` (`merge: accept BOOT-01 runtime skeleton`). The change adds a React/TypeScript static demo shell, a modular read-only Worker API with server-selected synthetic data, layer-owned interfaces, fixtures, tests, locked dependencies and a WSL bootstrap guide. It does not add a database, live source, model call, investigation loop, moderator write, cloud resource or API-contract change.

Root checks in WSL Ubuntu-26.04 with Linux Node.js 24.21.0/npm 11.19.0: `npm ci --offline --no-audit --no-fund` passed; `npm run dev` started Vite and local Wrangler without external `Request.cf` access; `npm run smoke` passed against both API routes; `npm test` passed all 6 tests; `npm run typecheck` passed both workspaces; `npm run build` passed Vite production build and Wrangler dry-run. Direct route checks returned HTTP 200 for context/events, stayed demo/synthetic with client dataset parameters, and rejected POST with 405. `git diff --check` passed on the task branch. Direct WSL access to npm was unavailable, so dependency setup used a temporary pass-through CONNECT relay restricted to `registry.npmjs.org:443`; it was stopped after dependency setup and did not persist a WSL/system setting.

BOOT-01 is accepted. UI-00 is the next active implementation on its own `work/UI-00-civic-interface` branch/worktree and uses the approved local synthetic shell. PLATFORM-01 is ready in dependency terms but remains planned while the requested UI slice proceeds. EVAL-01 still needs human-adjudicated labels; live source permissions, data retention/backup, model choice, map/geocoder terms, data region/privacy, quota stop levels and human research remain unresolved.

### UI-00 accepted — 24 September 2026

The root reviewed and merged the UI-00 feature branch into `main`. The implementation commits are `af19a4160858104cd8e44fdf9907b83201d05cd4` (`feat(UI-00): add civic discovery and evidence review`) and `eddb962211b31f378f268f319574ac6c719239c0` (`fix(UI-00): link map to explicit feed selection`). Root merge: `6e1e8a3ad3c0ae3946c4e94e55cbfc2c77f488d4` (`Merge branch 'work/UI-00-civic-interface'`). The detailed branch handoff and findings are in [the UI-00 assignment](assignments/UI-00.md).

Changed paths are limited to `apps/web/**`: the shell, feed/map, event detail, read-only moderator review, local presentation fixture, display helpers, styles, smoke check, and UI tests. The screen slice keeps fixture-only data separate from API records, starts with no map geometry selected, renders only the documented synthetic route after an explicit selection, preserves independent status/time labels, and introduces no moderator writes or API changes.

Root independently reran checks in WSL Ubuntu-26.04 with Node.js 24.21.0/npm 11.19.0: `npm run typecheck` passed; `npm test` passed all 9 tests (5 web, 4 Worker); `npm run smoke` passed against the local Vite/Worker pair; `npm run build` passed the Vite production build and Wrangler dry-run; and `git diff --check` passed. The local UI/API routes returned HTTP 200 during visual review.

Desktop discovery was reviewed at 1440×1000. Discovery/map, detail, and moderator layouts were also reviewed at 390×844; a narrower 720 CSS-pixel desktop viewport showed no horizontal clipping. Screenshots are retained locally under ignored `.codex-build/ui-00-review/`. The critique refined initial map selection, mobile copy/wrapping, URL state, and search scope labels. Remaining limitations are synthetic-only data, no basemap/live source/authentication/publication, and read-only moderator behavior; UI-00 is a front-end fixture slice, not proof of live coverage or safety.

PLATFORM-01 is the next ready task: measure Cloudflare Workers and Neon Free compatibility in WSL and against current official documentation. This work must remain a no-provisioning spike; its results constrain DATA-01 schema decisions. Human evaluation labels and live-source activation gates remain outstanding.

### PLATFORM-01 assigned — 24 September 2026

After pushing the accepted UI-00 checkpoint, root assigned the no-provisioning compatibility spike to a dedicated Luna Max branch/worktree. The scope is recorded in [the PLATFORM-01 assignment](assignments/PLATFORM-01.md). The report must cite current official provider documentation and distinguish hard limits, reproducible local measurements, scenario estimates, and facts that require an authorized provider resource. No Cloudflare or Neon resource, account change, paid service, secret, or live data access is part of the assignment.

### PLATFORM-01 accepted — 24 September 2026

The root reviewed and merged PLATFORM-01 from `work/PLATFORM-01-free-compatibility`. Agent commits: `bc7f414ccaaf9b5cc707022632c439d93fe4080a` (`docs(PLATFORM-01): assess free-tier compatibility`), `839873f9346e20b7b097bc853f8dac7ab73513e3` (`docs(PLATFORM-01): record implementation handoff`), and `4b4908c803f7d93c80d618c6aeb2bee5b23e6e2d` (`docs(PLATFORM-01): align Workflow sensitivity with planned cadences`). Root merge: `80f9636` (`merge: accept PLATFORM-01 compatibility spike`). Changed paths are `docs/PLATFORM_COMPATIBILITY.md`, `docs/decisions/ADR-010-cloudflare-neon-free.md`, `REFERENCES.md`, and the task handoff in `docs/assignments/PLATFORM-01.md`.

The report records current official Cloudflare and Neon documentation accessed 24 September 2026, plus WSL-local fixture measurements for route response sizes/timings and build artifacts. It clearly separates documented limits, local measurements, arithmetic scenarios, and provider facts that remain untested. The project’s proposed source cadences (BMKG 2 minutes, PetaBencana 5 minutes, news/traffic 10 minutes) are preserved as unvalidated proposals. At an illustrative 10 billable Workflow steps/run, their per-schedule estimates are 7,200, 2,880, and 1,440 steps/day; the first exceeds the 3,000-step daily Free allowance. Actual steps/run and shared-versus-separate workflow schedules must be measured before setting source cadence.

The bounded synthetic class-demo target remains plausible from public ceilings, but Cloudflare CPU, Neon query/transfer/latency, Workflows, provider error handling, and Free-project extension activation are not validated. The required 30-day off-provider backup, restore, and deletion-replay path remains absent; persist synthetic/historical demo data only and keep live-source persistence blocked. No external resource, credential, paid usage, account change, live data, or deployment was used.

Agent WSL Ubuntu-26.04 checks passed with Node.js 24.21.0/npm 11.19.0: `npm run typecheck`, `npm test` (9/9), `npm run smoke`, and `npm run build` including Wrangler dry-run. The local Vite proxy briefly logged connection refusals before Wrangler readiness; measured and smoke requests after readiness returned HTTP 200. Root independently ran `git diff --check main..work/PLATFORM-01-free-compatibility` in WSL; it passed. No runtime tests were rerun for the docs-only cadence correction. The detailed measurements and caveats are in [the compatibility report](PLATFORM_COMPATIBILITY.md).

Root acceptance documentation was committed as `53bac0b` (`docs(PLATFORM-01): accept free-tier compatibility spike`) and pushed to `origin/main` on 24 September 2026. DATA-01 is the next ready task; its local-only scope is recorded in [the assignment](assignments/DATA-01.md). It will use the documented ceilings without creating a Neon project or enabling live persistence.

### DATA-01 assigned — 24 September 2026

Root published the [DATA-01 assignment](assignments/DATA-01.md) in `b536eee` (`docs(DATA-01): scope local persistence foundation`) and created `work/DATA-01-postgres-foundation` in its own `.codex-build/worktrees/data-01` worktree. The assignment targets a local PostgreSQL 18-compatible schema, versioned migrations, PostGIS/pgvector support and typed repository ports, with WSL synthetic tests only. It forbids Neon/Hyperdrive provisioning, live-source persistence, secrets, OS-level package installation and API-contract changes. No implementation or database tests are claimed yet; the implementation branch will be reviewed and recorded before integration.

### DATA-01 implementation checkpoint — 24 September 2026

At the user's stop request, DATA-01 was preserved as an unaccepted WIP checkpoint rather than merged. Agent commit `b4bf7e42451f1d1fe13e9758c363e11a13eeec31` (`wip(DATA-01): checkpoint PostgreSQL foundation`) is on `work/DATA-01-postgres-foundation` and was pushed to the matching origin branch. It adds the PostgreSQL migration, migration runner, typed repository ports, local PGlite/PostGIS/pgvector harness and synthetic persistence tests, plus workspace wiring. The detailed status is recorded in [the DATA-01 assignment](assignments/DATA-01.md).

Root ran `npm run typecheck` in WSL Ubuntu-26.04 with Node.js 24.21.0/npm 11.19.0; it passed. Root ran `npm run db:test`; 8/9 tests passed and the vector-distance ordering assertion failed at `apps/db/test/persistence.test.ts:197` (actual `[2,3,2]`, expected `[2,2,3]`). The agent reports `npm ci --offline --no-audit --no-fund` passed. `npm test`, `npm run build`, `npm run smoke`, and `git diff --check` remain unrun. This branch is not merged or accepted; PGlite PostGIS is experimental and does not verify Neon or provider extension compatibility. No OS packages or provider resources were added.

### Checkpoint at user's stop request — 24 September 2026

Implementation work is stopped at the user's request. No subagent is still running. The integrated `main` implementation baseline is `0b46cf7` (`docs(DATA-01): record WIP checkpoint`), already on `origin/main`; this entry records the newer stop-state checkpoint. BOOT-01, UI-00, and PLATFORM-01 remain accepted and integrated; their worktrees are clean. No next implementation task has started.

DATA-01 is preserved as unaccepted work on `work/DATA-01-postgres-foundation`, pushed to `origin` at `b996c72` (`docs(DATA-01): record checkpoint preservation`). It contains the schema/migration runner, repository ports, local PGlite/PostGIS/pgvector test harness and synthetic persistence tests. Follow-up fixes add per-run vector-dimension assertions, gate automatic source acquisition on active/approved policy, separate L1 connector-health privileges from L4 source-policy privileges, reject backdated migrations, and bind embedding input hashes to chunk hashes. Changed paths are the root package manifests plus `apps/db/**` and the DATA-01 assignment handoff. No Worker/API database integration, provider configuration, live source persistence, or API contract change was made.

The DATA-01 handoff reports WSL Ubuntu-26.04 checks with Node.js `v24.21.0` and npm `11.19.0`: `npm run db:test` passed 11/11; `npm test` passed 20/20; `npm run typecheck` and `npm run build` passed; and `git diff --check` passed with explicit WSL Git/worktree paths. `npm run smoke` was not run because API/Worker runtime integration was unchanged. These are agent-reported results; root has not independently rerun the final branch after its last fixes. The branch is clean and pushed but remains unmerged pending root review. The earlier vector-ordering failure in the initial DATA-01 checkpoint was addressed by the branch follow-up; no test result is rewritten or implied for the old revision.

The remaining stop-state constraints are: confirm migration/schema alignment during root review; do not treat PGlite extension behavior as Neon compatibility evidence; keep live-source persistence gated by reuse permission and backup/deletion-replay readiness; and defer JOB-01 until DATA-01 is reviewed. Human-adjudicated evaluation labels and provider/access decisions remain outstanding. The repository is left with clean `main` and a clean, separately checkpointed DATA-01 branch; no merge, deployment, or external resource provisioning occurred.

### DATA-01 accepted — 24 September 2026

After the stop checkpoint was resumed, root reviewed `work/DATA-01-postgres-foundation` through `b996c72` and merged it into `main` as `ed5b5c4` (`merge: accept DATA-01 persistence foundation`). The assignment, backlog, domain model, bootstrap guide, architecture overview and platform compatibility report now distinguish the accepted local persistence foundation from unimplemented Worker/Neon integration. DATA-01 adds the PostgreSQL/PostGIS/pgvector schema, checksum-protected migration runner, typed source/report/trace/audit ports and synthetic PGlite tests. The branch also includes policy/privilege boundary tests, ordered-migration rejection and embedding hash lineage. Changes stayed within the assigned paths.

Root independently ran the final code in WSL Ubuntu-26.04 with native Node.js `v24.21.0` and npm `11.19.0`: `npm run db:test` passed 11/11; `npm test` passed 20/20 (web 5, Worker 4, database 11); `npm run typecheck` passed; `npm run build` passed Vite production build and Wrangler deploy dry-run; `npm run smoke` passed against the local Vite/Worker pair; and `git diff --check main...work/DATA-01-postgres-foundation` passed using explicit WSL Git/worktree paths. The first smoke invocation had no servers running; root then started both documented local services and the rerun passed. No deployment, provider, live-source, or model test was run. The initial WIP vector-ordering failure remains documented as historical; the corrected branch passed.

DATA-01 is accepted only as a local persistence foundation. No Worker DB driver or API wiring exists. Neon/Postgres extension behavior, role-creation privileges on Neon, and provider capacity remain unverified. Report review-state transition history and deletion replay remain LIFE-01 work. The prior stop-state checkpoint remains an accurate historical record as of that point; implementation resumed only after the subsequent user continuation.

### JOB-01 assigned — 24 September 2026

After accepting DATA-01, root recorded [ADR-002](decisions/ADR-002-job-queue-and-scheduler.md) and the [JOB-01 assignment](assignments/JOB-01.md) in `7f76c42` (`docs(JOB-01): define durable queue boundaries`), then created `work/JOB-01-durable-queue` in `.codex-build/worktrees/job-01`. The implementation scope is a local PostgreSQL queue/repository boundary with idempotent scheduled/manual acquisition requests, finite leases/attempts/backoff, crash recovery and connector-health updates. It excludes external scheduler bindings, database drivers, live sources, model calls and public API changes. The implementation agent has not yet returned code or test results.

### User-requested pause checkpoint — 25 September 2026

Implementation was stopped at the user's request and the active JOB-01 subagent was interrupted. The main checkout was clean and synchronized with `origin/main` at `41324d4` before this checkpoint. Root preserved the agent's sole untracked artifact, `apps/db/migrations/002_acquisition_jobs.sql`, with a clear incomplete/unreviewed note in `docs/assignments/JOB-01.md`; both are committed as `0d51db0` (`wip(JOB-01): checkpoint interrupted queue schema`) on `work/JOB-01-durable-queue`. No JOB-01 tests or review were run, and this WIP branch was not pushed or merged.

The full snapshot, integrated components, branches, previously completed checks, outstanding gates, and resume point are recorded in [CURRENT_CHECKPOINT.md](CURRENT_CHECKPOINT.md). Root added only the checkpoint record to `main`; `git diff --check` passed in WSL before commit. No implementation task is continuing.
