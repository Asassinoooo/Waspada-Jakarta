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
