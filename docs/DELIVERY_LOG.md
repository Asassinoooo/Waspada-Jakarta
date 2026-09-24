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
